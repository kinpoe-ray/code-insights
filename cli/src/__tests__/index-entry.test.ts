import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const entryState = vi.hoisted(() => ({
  asyncActionWasAwaited: false,
  lockRunArgs: null as string[] | null,
  lockRunResult: 0,
  maintenanceActionWasCalled: false,
  reanalyzeAction: null as string | null,
  installHookOptions: null as { native?: boolean } | null,
  sessionEndOptions: null as { native?: boolean; quiet?: boolean } | null,
}));

vi.mock('../commands/init.js', () => ({ initCommand: vi.fn() }));
vi.mock('../commands/sync.js', () => ({
  syncCommand: vi.fn(),
  getTrivialSessions: vi.fn(() => []),
  pruneTrivialSessions: vi.fn(),
}));
vi.mock('../commands/status.js', () => ({ statusCommand: vi.fn() }));
vi.mock('../commands/install-hook.js', () => ({
  installHookCommand: vi.fn((options?: { native?: boolean }) => {
    entryState.installHookOptions = options ?? {};
  }),
  uninstallHookCommand: vi.fn(),
}));
vi.mock('../commands/open.js', () => ({ openCommand: vi.fn() }));
vi.mock('../commands/dashboard.js', () => ({ dashboardCommand: vi.fn() }));
vi.mock('../commands/insights.js', () => ({
  insightsCommand: vi.fn(),
  insightsCheckCommand: vi.fn(),
}));
vi.mock('../commands/session-end.js', () => ({
  sessionEndCommand: vi.fn((options?: { native?: boolean; quiet?: boolean }) => {
    entryState.sessionEndOptions = options ?? {};
  }),
}));
vi.mock('../commands/doctor/index.js', () => ({ doctorCommand: vi.fn() }));
vi.mock('../commands/lock-run.js', () => ({
  runCommandWithLlmLock: vi.fn(async (command: string[]) => {
    entryState.lockRunArgs = command;
    return entryState.lockRunResult;
  }),
}));
vi.mock('../commands/maintenance.js', async () => {
  const { Command } = await vi.importActual<typeof import('commander')>('commander');
  const command = new Command('maintenance');
  command.command('status').action(() => {
    entryState.maintenanceActionWasCalled = true;
  });
  return { buildMaintenanceCommand: () => command };
});

vi.mock('../commands/reanalyze.js', async () => {
  const { Command } = await vi.importActual<typeof import('commander')>('commander');
  return {
    buildReanalyzeCommand: () => {
      const command = new Command('reanalyze')
        .option('--dry-run')
        .action(() => { entryState.reanalyzeAction = 'dry-run'; });
      command.command('run').option('--json').action(() => {
        entryState.reanalyzeAction = 'run';
      });
      return command;
    },
  };
});

vi.mock('../commands/reset.js', async () => {
  const { Command } = await vi.importActual<typeof import('commander')>('commander');
  return { resetCommand: new Command('reset') };
});
vi.mock('../commands/stats/index.js', async () => {
  const { Command } = await vi.importActual<typeof import('commander')>('commander');
  return { statsCommand: new Command('stats') };
});
vi.mock('../commands/config.js', async () => {
  const { Command } = await vi.importActual<typeof import('commander')>('commander');
  return { configCommand: new Command('config') };
});
vi.mock('../commands/telemetry.js', async () => {
  const { Command } = await vi.importActual<typeof import('commander')>('commander');
  return { telemetryCommand: new Command('telemetry') };
});
vi.mock('../commands/queue.js', async () => {
  const { Command } = await vi.importActual<typeof import('commander')>('commander');
  return { buildQueueCommand: () => new Command('queue') };
});

vi.mock('../commands/reflect.js', async () => {
  const { Command } = await vi.importActual<typeof import('commander')>('commander');
  const reflectCommand = new Command('reflect');

  reflectCommand.action(() => {
    const rejection = new Error('Synthetic asynchronous command failure');
    const thenable = {
      then(
        _onFulfilled: (value?: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        // Commander.parse() chains thenables without awaiting their rejection,
        // while parseAsync() eventually supplies an onRejected callback.
        if (onRejected) {
          entryState.asyncActionWasAwaited = true;
          onRejected(rejection);
        }
        return thenable;
      },
    };
    return thenable as unknown as Promise<void>;
  });

  return { reflectCommand };
});

vi.mock('../utils/telemetry.js', () => ({ showTelemetryNoticeIfNeeded: vi.fn() }));

describe('CLI production entry point', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    entryState.asyncActionWasAwaited = false;
    entryState.lockRunArgs = null;
    entryState.lockRunResult = 0;
    entryState.maintenanceActionWasCalled = false;
    entryState.reanalyzeAction = null;
    entryState.installHookOptions = null;
    entryState.sessionEndOptions = null;
    process.argv = ['node', 'code-insights', 'reflect'];
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('awaits an asynchronous command failure and reports it without a stack trace', async () => {
    await import('../index.js');

    expect(entryState.asyncActionWasAwaited).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      '[Code Insights] Synthetic asynchronous command failure',
    );
  }, 20_000);

  it('passes all child arguments to lock-run and propagates its exit status', async () => {
    process.argv = [
      'node',
      'code-insights',
      'lock-run',
      '/usr/bin/example',
      '--child-flag',
      'value',
    ];
    entryState.lockRunResult = 7;
    vi.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new Error(`process.exit(${String(code)})`);
    });

    await import('../index.js');

    expect(entryState.lockRunArgs).toEqual([
      '/usr/bin/example',
      '--child-flag',
      'value',
    ]);
    expect(process.exitCode).toBe(7);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('exposes maintenance controls through the production CLI', async () => {
    process.argv = ['node', 'code-insights', 'maintenance', 'status'];

    await import('../index.js');

    expect(entryState.maintenanceActionWasCalled).toBe(true);
  });

  it('exposes the durable reanalysis campaign through the production CLI', async () => {
    process.argv = ['node', 'code-insights', 'reanalyze', 'run', '--json'];

    await import('../index.js');

    expect(entryState.reanalyzeAction).toBe('run');
  });

  it('reports a busy lock concisely and preserves exit status 75', async () => {
    process.argv = ['node', 'code-insights', 'lock-run', '/usr/bin/true'];
    entryState.lockRunResult = 75;
    vi.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new Error(`process.exit(${String(code)})`);
    });

    await import('../index.js');

    expect(entryState.lockRunArgs).toEqual(['/usr/bin/true']);
    expect(process.exitCode).toBe(75);
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      '[Code Insights] Another LLM analysis process is already running.',
    );
  });

  it('keeps the internal lock-run command out of public help', async () => {
    process.argv = ['node', 'code-insights', '--help'];
    let helpOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk): boolean => {
      helpOutput += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('help complete');
    });

    await import('../index.js');

    expect(helpOutput).not.toContain('lock-run');
  });

  it('installs a provider-backed hook when requested', async () => {
    process.argv = ['node', 'code-insights', 'install-hook', '--provider'];

    await import('../index.js');

    expect(entryState.installHookOptions).toEqual({ native: false });
  });

  it('runs SessionEnd automation through the configured provider when requested', async () => {
    process.argv = ['node', 'code-insights', 'session-end', '--provider', '--quiet'];

    await import('../index.js');

    expect(entryState.sessionEndOptions).toMatchObject({ native: false, quiet: true });
  });

  it.each([
    ['sync', '--dry-run'],
    ['sync', '--source', 'codex-cli', '--dry-run'],
    ['sync', '--dry-run', '--project', 'example'],
  ])('does not persist the telemetry notice for a dry-run sync: %j', async (...args) => {
    process.argv = ['node', 'code-insights', ...args];

    await import('../index.js');
    const { showTelemetryNoticeIfNeeded } = await import('../utils/telemetry.js');

    expect(showTelemetryNoticeIfNeeded).not.toHaveBeenCalled();
  });

  it('keeps a reanalysis dry run free of the telemetry notice', async () => {
    process.argv = ['node', 'code-insights', 'reanalyze', '--dry-run'];

    await import('../index.js');
    const { showTelemetryNoticeIfNeeded } = await import('../utils/telemetry.js');

    expect(entryState.reanalyzeAction).toBe('dry-run');
    expect(showTelemetryNoticeIfNeeded).not.toHaveBeenCalled();
  });

  it('keeps maintenance status output free of the telemetry notice', async () => {
    process.argv = ['node', 'code-insights', 'maintenance', 'status'];

    await import('../index.js');
    const { showTelemetryNoticeIfNeeded } = await import('../utils/telemetry.js');

    expect(showTelemetryNoticeIfNeeded).not.toHaveBeenCalled();
  });
});
