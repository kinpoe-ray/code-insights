import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import { trackEvent, captureError, classifyError } from '../utils/telemetry.js';
import {
  HOOKS_FILE,
  CLI_ENTRY,
  type ClaudeSettings,
  type HookConfig,
  getHookCommand,
} from '../utils/hooks-utils.js';

interface FileFingerprint {
  device: bigint;
  inode: bigint;
  mode: bigint;
  size: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

type SettingsFileTarget =
  | { kind: 'missing'; path: string }
  | { kind: 'file'; path: string; fingerprint: FileFingerprint }
  | { kind: 'symlink'; path: string; linkPath: string; fingerprint: FileFingerprint };

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function fingerprintFromStat(entry: fs.BigIntStats): FileFingerprint {
  return {
    device: entry.dev,
    inode: entry.ino,
    mode: entry.mode,
    size: entry.size,
    modifiedAt: entry.mtimeNs,
    changedAt: entry.ctimeNs,
  };
}

function getFileFingerprint(filePath: string): FileFingerprint {
  return fingerprintFromStat(fs.statSync(filePath, { bigint: true }));
}

function fingerprintsMatch(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.size === right.size
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt;
}

/**
 * Resolve settings.json without ever replacing a user-managed symlink.
 * Dangling links and non-regular targets are rejected rather than treated as
 * an absent settings file.
 */
function resolveSettingsFileTarget(): SettingsFileTarget {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(HOOKS_FILE);
  } catch (error) {
    if (isMissingFileError(error)) return { kind: 'missing', path: HOOKS_FILE };
    throw error;
  }

  if (entry.isSymbolicLink()) {
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(HOOKS_FILE);
    } catch (error) {
      throw new Error(
        'Claude settings.json is a dangling or unsafe symbolic link; refusing to replace it.',
        { cause: error },
      );
    }
    const resolvedEntry = fs.statSync(resolvedPath, { bigint: true });
    if (!resolvedEntry.isFile()) {
      throw new Error(
        'Claude settings.json symbolic link does not resolve to a regular file; refusing to modify it.',
      );
    }
    return {
      kind: 'symlink',
      path: resolvedPath,
      linkPath: HOOKS_FILE,
      fingerprint: fingerprintFromStat(resolvedEntry),
    };
  }

  if (!entry.isFile()) {
    throw new Error('Claude settings.json is not a regular file; refusing to modify it.');
  }
  return { kind: 'file', path: HOOKS_FILE, fingerprint: getFileFingerprint(HOOKS_FILE) };
}

function assertSettingsTargetUnchanged(target: SettingsFileTarget): void {
  if (target.kind === 'symlink') {
    const entry = fs.lstatSync(target.linkPath);
    if (!entry.isSymbolicLink() || fs.realpathSync(target.linkPath) !== target.path) {
      throw new Error('Claude settings.json symbolic link changed while it was being updated.');
    }
    if (!fingerprintsMatch(target.fingerprint, getFileFingerprint(target.path))) {
      throw new Error('Claude settings.json changed while it was being updated.');
    }
    return;
  }

  try {
    const entry = fs.lstatSync(HOOKS_FILE);
    if (target.kind === 'missing' || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Claude settings.json changed while it was being updated.');
    }
    if (!fingerprintsMatch(target.fingerprint, getFileFingerprint(target.path))) {
      throw new Error('Claude settings.json changed while it was being updated.');
    }
  } catch (error) {
    if (target.kind === 'missing' && isMissingFileError(error)) return;
    throw error;
  }
}

function writeSettingsAtomically(settings: ClaudeSettings, target: SettingsFileTarget): void {
  const destinationDirectory = path.dirname(target.path);
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const temporaryFile = path.join(
    destinationDirectory,
    `.settings.json.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.chmodSync(temporaryFile, 0o600);
    assertSettingsTargetUnchanged(target);
    fs.renameSync(temporaryFile, target.path);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function sessionEndHookCommand(): string {
  const configDir = process.env.CODE_INSIGHTS_CONFIG_DIR;
  if (process.platform === 'win32') {
    const cliEntry = `"${CLI_ENTRY.replace(/"/g, '""')}"`;
    const prefix = configDir
      ? `set "CODE_INSIGHTS_CONFIG_DIR=${configDir.replace(/"/g, '""')}" && `
      : '';
    return `${prefix}node ${cliEntry} session-end --native -q`;
  }

  const prefix = configDir
    ? `CODE_INSIGHTS_CONFIG_DIR=${shellQuote(configDir)} `
    : '';
  return `${prefix}node ${shellQuote(CLI_ENTRY)} session-end --native -q`;
}

/**
 * Remove any existing Code Insights Stop hooks (v4.8.x migration).
 * v4.8.x installed a Stop hook for sync; v4.9+ uses a single SessionEnd hook.
 * Called on install so re-running install-hook cleans up the old setup.
 */
function removeStopHooks(settings: ClaudeSettings): boolean {
  if (!settings.hooks?.Stop) return false;
  const before = settings.hooks.Stop.length;
  settings.hooks.Stop = settings.hooks.Stop.filter(
    (h) => !h.hooks.some((hook) => getHookCommand(hook).includes('code-insights'))
  );
  if (settings.hooks.Stop.length === 0) {
    delete settings.hooks.Stop;
  }
  return settings.hooks.Stop === undefined
    ? before > 0
    : settings.hooks.Stop.length < before;
}

/**
 * Install the single Code Insights SessionEnd hook.
 *
 * v4.9+ uses one SessionEnd hook that does sync + enqueue + worker spawn.
 * Running install-hook again removes the old Stop hook (v4.8.x hygiene) and
 * installs a fresh session-end hook.
 */
export async function installHookCommand(): Promise<void> {
  console.log(chalk.cyan('\nInstall Code Insights Hook\n'));

  const sessionEndCommand = sessionEndHookCommand();

  console.log(chalk.gray('This will add one Claude Code SessionEnd hook:\n'));
  console.log(chalk.white('  SessionEnd hook — Syncs and analyzes sessions when they end'));
  console.log(chalk.gray('                    Uses your Claude subscription. No API key needed.\n'));

  try {
    const settingsTarget = resolveSettingsFileTarget();
    // Load existing settings
    let settings: ClaudeSettings = {};
    if (settingsTarget.kind !== 'missing') {
      try {
        const content = fs.readFileSync(settingsTarget.path, 'utf-8');
        settings = JSON.parse(content);
      } catch (error) {
        throw new Error(
          'Could not read or parse existing Claude settings.json; refusing to overwrite it.',
          { cause: error },
        );
      }
    }

    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Clean up v4.8.x Stop hook if present (sync hook from old two-hook system).
    const removedStop = removeStopHooks(settings);
    if (removedStop) {
      console.log(chalk.dim('  Removed legacy Stop hook from v4.8.x'));
    }

    // Replace any older Code Insights SessionEnd entry so upgrades refresh the
    // absolute CLI path and any pinned configuration directory.
    if (!settings.hooks.SessionEnd) {
      settings.hooks.SessionEnd = [];
    }
    settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
      (entry) => !entry.hooks.some((hook) => getHookCommand(hook).includes('code-insights')),
    );
    const newHook: HookConfig = {
      // timeout: 10s is enough — session-end exits immediately after spawn
      hooks: [{ type: 'command', command: sessionEndCommand, timeout: 10000 }],
    };
    settings.hooks.SessionEnd.push(newHook);

    // Write settings
    writeSettingsAtomically(settings, settingsTarget);

    console.log(chalk.green('Hook installed successfully!'));
    console.log(chalk.gray(`\nConfiguration saved to: ${HOOKS_FILE}`));
    console.log(chalk.cyan('\nHow it works:'));
    console.log(chalk.white('  When a session ends, Code Insights syncs it and queues it for analysis.'));
    console.log(chalk.white('  Analysis runs in the background — no delay when you end a session.'));
    console.log(chalk.dim('\n  Check queue status: code-insights queue status'));

    trackEvent('cli_install_hook', {
      success: true,
      hook_types: 'session-end',
      sync_installed: false,
      analysis_installed: true,
    });
  } catch (error) {
    console.log(chalk.red(`Failed to install hook: ${error instanceof Error ? error.message : 'Unknown error'}`));
    const { error_type, error_message } = classifyError(error);
    trackEvent('cli_install_hook', { success: false, error_type, error_message });
    captureError(error, { command: 'install_hook', error_type });
    throw error;
  }
}

/**
 * Uninstall Code Insights hooks.
 * Handles both v4.9+ (SessionEnd session-end) and v4.8.x (Stop sync + SessionEnd insights --hook).
 */
export async function uninstallHookCommand(): Promise<void> {
  console.log(chalk.cyan('\nUninstall Code Insights Hooks\n'));

  try {
    const settingsTarget = resolveSettingsFileTarget();
    if (settingsTarget.kind === 'missing') {
      console.log(chalk.yellow('No hooks file found. Nothing to uninstall.'));
      return;
    }

    let settings: ClaudeSettings;
    try {
      const content = fs.readFileSync(settingsTarget.path, 'utf-8');
      settings = JSON.parse(content);
    } catch (error) {
      throw new Error(
        'Could not read or parse existing Claude settings.json; refusing to overwrite it.',
        { cause: error },
      );
    }

    if (!settings.hooks?.Stop && !settings.hooks?.SessionEnd) {
      console.log(chalk.yellow('No Code Insights hooks found. Nothing to uninstall.'));
      return;
    }

    // Remove all Code Insights hooks (Stop and SessionEnd, any command format)
    if (settings.hooks.Stop) {
      settings.hooks.Stop = settings.hooks.Stop.filter(
        (h) => !h.hooks.some((hook) => getHookCommand(hook).includes('code-insights'))
      );
      if (settings.hooks.Stop.length === 0) {
        delete settings.hooks.Stop;
      }
    }

    if (settings.hooks.SessionEnd) {
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(
        (h) => !h.hooks.some((hook) => getHookCommand(hook).includes('code-insights'))
      );
      if (settings.hooks.SessionEnd.length === 0) {
        delete settings.hooks.SessionEnd;
      }
    }

    // Clean up empty hooks object
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeSettingsAtomically(settings, settingsTarget);

    console.log(chalk.green('Hooks uninstalled successfully!'));
  } catch (error) {
    console.log(chalk.red('Failed to uninstall hooks:'));
    console.error(error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}
