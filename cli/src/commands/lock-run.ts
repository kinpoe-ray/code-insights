import { spawn, spawnSync } from 'child_process';
import { acquireLlmLock } from '../analysis/llm-lock.js';

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

interface ProcessTreeChild {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface TaskkillResult {
  readonly status: number | null;
  readonly error?: Error;
}

interface TaskkillOptions {
  readonly shell: false;
  readonly stdio: 'ignore';
  readonly timeout: number;
  readonly windowsHide: true;
}

type TaskkillRunner = (
  command: string,
  args: string[],
  options: TaskkillOptions,
) => TaskkillResult;

interface ProcessTreeTerminationOptions {
  readonly platform?: NodeJS.Platform;
  readonly runTaskkill?: TaskkillRunner;
}

const defaultTaskkillRunner: TaskkillRunner = (command, args, options) => {
  const result = spawnSync(command, args, options);
  return { status: result.status, error: result.error };
};

/** Terminate a child and, where supported, all of its descendants. */
export function terminateChildProcessTree(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminationOptions = {},
): void {
  const platform = options.platform ?? process.platform;

  if (platform === 'win32' && child.pid) {
    try {
      const result = (options.runTaskkill ?? defaultTaskkillRunner)(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        {
          shell: false,
          stdio: 'ignore',
          timeout: 5_000,
          windowsHide: true,
        },
      );
      if (!result.error && result.status === 0) return;
    } catch {
      // Fall through when taskkill is missing or cannot be started.
    }
  } else if (platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may have already exited; fall back to the direct child.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The child has already exited.
  }
}

/**
 * Run one command while holding the shared LLM lock.
 *
 * The child receives CODE_INSIGHTS_LOCK_HELD=1 so nested Code Insights
 * commands reuse the parent's lock instead of attempting a second acquisition.
 */
export async function runCommandWithLlmLock(
  command: string[],
  terminationOptions: ProcessTreeTerminationOptions = {},
): Promise<number> {
  if (command.length === 0 || !command[0]) {
    throw new Error('A command is required after lock-run.');
  }

  const lock = acquireLlmLock();
  if (!lock) return 75;

  try {
    return await new Promise<number>((resolve, reject) => {
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        CODE_INSIGHTS_LOCK_HELD: '1',
      };
      if (lock.token) childEnv.CODE_INSIGHTS_LOCK_TOKEN = lock.token;
      const child = spawn(command[0], command.slice(1), {
        stdio: 'inherit',
        env: childEnv,
        // A separate POSIX process group lets launchd/terminal signals reach
        // the shell command and every LLM grandchild it is waiting for.
        detached: (terminationOptions.platform ?? process.platform) !== 'win32',
      });

      let settled = false;
      let forwardedSignal: NodeJS.Signals | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      const signalHandlers = new Map<NodeJS.Signals, () => void>();
      const cleanupListeners = (): void => {
        for (const [signal, handler] of signalHandlers) {
          process.off(signal, handler);
        }
        if (forceKillTimer) clearTimeout(forceKillTimer);
      };
      const killChildTree = (signal: NodeJS.Signals): void => {
        terminateChildProcessTree(child, signal, terminationOptions);
      };
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        callback();
      };

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const handler = (): void => {
          forwardedSignal ??= signal;
          killChildTree(signal);
          if (!forceKillTimer) {
            forceKillTimer = setTimeout(() => killChildTree('SIGKILL'), 5_000);
          }
        };
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }

      child.once('error', (error) => settle(() => reject(error)));
      child.once('exit', (code, signal) => settle(() => {
        // The shell may exit from its trap before an ignoring grandchild does.
        // Tear down any remaining members before releasing the global lock.
        if (forwardedSignal) killChildTree('SIGKILL');
        if (forwardedSignal) {
          resolve(SIGNAL_EXIT_CODES[forwardedSignal] ?? 1);
          return;
        }
        if (code !== null) {
          resolve(code);
          return;
        }
        resolve(signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : 1);
      }));
    });
  } finally {
    lock.release();
  }
}
