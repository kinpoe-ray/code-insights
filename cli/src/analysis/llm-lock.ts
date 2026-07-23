import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, win32 } from 'path';
import { randomUUID, timingSafeEqual } from 'crypto';
import { spawnSync } from 'child_process';

export interface LlmLockHandle {
  /** Capability passed only to descendants that may delegate work over HTTP. */
  readonly token?: string;
  release(): void;
}

export const LLM_LOCK_TOKEN_HEADER = 'x-code-insights-lock-token';

const OWNER_WRITE_GRACE_MS = 60_000;

export function getLlmLockPath(): string {
  const configDir = process.env.CODE_INSIGHTS_CONFIG_DIR
    || join(homedir(), '.code-insights');
  return process.env.CODE_INSIGHTS_LLM_LOCK_DIR
    || join(configDir, 'locks', 'llm.lock');
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function getProcessStartIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) return null;
      // Fields after the command name start at proc field 3; starttime is 22.
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!startTicks) return null;
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
      return `linux:${bootId}:${startTicks}`;
    } catch {
      return null;
    }
  }

  try {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot
        || process.env.SYSTEMROOT
        || process.env.windir
        || process.env.WINDIR;
      if (!systemRoot || !win32.isAbsolute(systemRoot)) return null;
      const powerShell = win32.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const result = spawnSync(
        powerShell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: 'utf-8', timeout: 2_000, windowsHide: true },
      );
      const startedAt = result.status === 0 ? result.stdout.trim() : '';
      return startedAt ? `win32:${startedAt}` : null;
    }

    const psCommand = process.platform === 'darwin' ? '/bin/ps' : 'ps';
    const result = spawnSync(
      psCommand,
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf-8',
        timeout: 2_000,
        windowsHide: true,
        // ps lstart is localized on macOS. Lock owners and contenders often
        // run under different terminal/LaunchAgent locales, so canonicalize it.
        env: {
          ...process.env,
          LANG: 'C',
          LC_ALL: 'C',
          TZ: 'UTC',
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        },
      },
    );
    const startedAt = result.status === 0 ? result.stdout.trim() : '';
    return startedAt ? `${process.platform}:${startedAt}` : null;
  } catch {
    return null;
  }
}

function readOwnerProcessStart(lockPath: string): string | null {
  try {
    const identity = readFileSync(join(lockPath, 'process-start'), 'utf-8').trim();
    return identity || null;
  } catch {
    // Locks written by older versions have only a PID. Preserve their
    // fail-closed behavior until that owner exits.
    return null;
  }
}

function isLockOwnerAlive(lockPath: string, pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  const recordedStart = readOwnerProcessStart(lockPath);
  if (recordedStart === null) return true;
  const currentStart = getProcessStartIdentity(pid);
  // If the platform cannot inspect process birth, do not steal a live lock.
  return currentStart === null || currentStart === recordedStart;
}

function tryCreateOwnedLock(lockPath: string): LlmLockHandle | null {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExistsError(error)) return null;
    throw error;
  }

  const token = randomUUID();
  const processStart = getProcessStartIdentity(process.pid);
  try {
    writeFileSync(join(lockPath, 'token'), `${token}\n`, { mode: 0o600 });
    if (processStart !== null) {
      writeFileSync(join(lockPath, 'process-start'), `${processStart}\n`, { mode: 0o600 });
    }
    // Publish the PID last. Until it exists, contenders use the owner-write
    // grace period instead of treating a partially initialized lock as stale.
    writeFileSync(join(lockPath, 'pid'), `${process.pid}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  const ownerPid = process.pid;
  return {
    token,
    release(): void {
      if (released) return;
      released = true;
      try {
        const currentOwnerPid = Number.parseInt(
          readFileSync(join(lockPath, 'pid'), 'utf-8').trim(),
          10,
        );
        if (currentOwnerPid !== ownerPid) return;
        const currentToken = readFileSync(join(lockPath, 'token'), 'utf-8').trim();
        const currentTokenBytes = Buffer.from(currentToken);
        const ownedTokenBytes = Buffer.from(token);
        if (currentTokenBytes.length !== ownedTokenBytes.length ||
            !timingSafeEqual(currentTokenBytes, ownedTokenBytes)) return;
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // The lock is gone or no longer readable; it is not safe to remove it.
      }
    },
  };
}

/** Validate a delegated-work capability against the currently held lock. */
export function isLlmLockTokenOwner(candidate: string | undefined): boolean {
  if (!candidate) return false;
  try {
    const lockPath = getLlmLockPath();
    const ownerPid = readOwnerPid(lockPath);
    if (ownerPid === null || !isLockOwnerAlive(lockPath, ownerPid)) return false;
    const expected = readFileSync(join(lockPath, 'token'), 'utf-8').trim();
    const candidateBytes = Buffer.from(candidate);
    const expectedBytes = Buffer.from(expected);
    return candidateBytes.length === expectedBytes.length
      && timingSafeEqual(candidateBytes, expectedBytes);
  } catch {
    return false;
  }
}

function readOwnerPid(lockPath: string): number | null {
  try {
    const ownerPid = Number.parseInt(readFileSync(join(lockPath, 'pid'), 'utf-8').trim(), 10);
    return Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
  } catch {
    return null;
  }
}

function isOwnerlessLockStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= OWNER_WRITE_GRACE_MS;
  } catch {
    return false;
  }
}

function reclaimStaleLock(lockPath: string, observedOwnerPid: number | null): LlmLockHandle | null {
  const recoveryLock = acquireLockAtPath(`${lockPath}.reclaim`);
  if (!recoveryLock) return null;

  try {
    const currentOwnerPid = readOwnerPid(lockPath);
    if (observedOwnerPid === null) {
      if (currentOwnerPid !== null || !isOwnerlessLockStale(lockPath)) return null;
    } else {
      if (currentOwnerPid !== observedOwnerPid || isLockOwnerAlive(lockPath, currentOwnerPid)) return null;
    }

    rmSync(lockPath, { recursive: true, force: true });
    return tryCreateOwnedLock(lockPath);
  } finally {
    recoveryLock.release();
  }
}

function acquireLockAtPath(lockPath: string): LlmLockHandle | null {
  const lock = tryCreateOwnedLock(lockPath);
  if (lock) return lock;

  const ownerPid = readOwnerPid(lockPath);
  if (ownerPid === null) {
    return isOwnerlessLockStale(lockPath)
      ? reclaimStaleLock(lockPath, null)
      : null;
  }
  if (isLockOwnerAlive(lockPath, ownerPid)) return null;

  return reclaimStaleLock(lockPath, ownerPid);
}

export function acquireLlmLock(): LlmLockHandle | null {
  if (process.env.CODE_INSIGHTS_LOCK_HELD === '1') {
    const token = process.env.CODE_INSIGHTS_LOCK_TOKEN;
    if (!isLlmLockTokenOwner(token)) return null;
    return {
      token,
      release: () => {},
    };
  }

  const lockPath = getLlmLockPath();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  return acquireLockAtPath(lockPath);
}
