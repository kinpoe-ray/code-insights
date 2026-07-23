import * as fs from 'fs';
import * as path from 'path';
import {
  HOOKS_FILE,
  CLI_ENTRY,
  loadClaudeSettings,
  getHookCommand,
  hookAlreadyInstalled,
} from '../../../utils/hooks-utils.js';
import type { Check, CheckResult } from '../types.js';

/** Extract the CLI path after the `node` executable from a shell command. */
function extractBinaryPath(command: string): string | null {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else if (character === '\\' && index + 1 < command.length) {
      token += command[index + 1];
      index += 1;
    } else {
      token += character;
    }
  }

  if (quote) return null;
  if (token) tokens.push(token);

  const nodeIndex = tokens.findIndex((candidate) => {
    const executable = candidate.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
    return executable === 'node' || executable === 'node.exe';
  });
  return nodeIndex >= 0 ? tokens[nodeIndex + 1] ?? null : null;
}

export function hooksChecks(): Check[] {
  return [
    {
      id: 'hooks.settings_exists',
      label: 'Claude settings',
      gate: true,
      run: async (): Promise<CheckResult> => {
        if (fs.existsSync(HOOKS_FILE)) {
          return { id: 'hooks.settings_exists', label: 'Claude settings', status: 'pass', detail: HOOKS_FILE };
        }
        return {
          id: 'hooks.settings_exists',
          label: 'Claude settings',
          status: 'warn',
          detail: `${HOOKS_FILE} not found`,
        };
      },
    },
    {
      id: 'hooks.session_end_installed',
      label: 'SessionEnd hook',
      run: async (): Promise<CheckResult> => {
        const settings = loadClaudeSettings();
        if (!settings?.hooks?.SessionEnd) {
          return {
            id: 'hooks.session_end_installed',
            label: 'SessionEnd hook',
            status: 'warn',
            detail: 'Not installed',
            hint: 'Run: code-insights install-hook',
          };
        }
        if (hookAlreadyInstalled(settings.hooks.SessionEnd)) {
          return { id: 'hooks.session_end_installed', label: 'SessionEnd hook', status: 'pass' };
        }
        return {
          id: 'hooks.session_end_installed',
          label: 'SessionEnd hook',
          status: 'warn',
          detail: 'SessionEnd hooks exist but none reference code-insights',
          hint: 'Run: code-insights install-hook',
        };
      },
    },
    {
      id: 'hooks.binary_exists',
      label: 'Hook binary path',
      run: async (): Promise<CheckResult> => {
        const settings = loadClaudeSettings();
        if (!settings?.hooks?.SessionEnd) {
          return { id: 'hooks.binary_exists', label: 'Hook binary path', status: 'skip', detail: 'No SessionEnd hook' };
        }

        for (const hookConfig of settings.hooks.SessionEnd) {
          for (const hook of hookConfig.hooks) {
            const cmd = getHookCommand(hook);
            if (!cmd.includes('code-insights')) continue;
            const binPath = extractBinaryPath(cmd);
            if (!binPath) continue;
            if (fs.existsSync(binPath)) {
              return { id: 'hooks.binary_exists', label: 'Hook binary path', status: 'pass', detail: binPath };
            }
            return {
              id: 'hooks.binary_exists',
              label: 'Hook binary path',
              status: 'fail',
              detail: `Hook points to a path that no longer exists: ${binPath}`,
              hint: 'Run: code-insights install-hook\n           (rewrites hook to use current binary path)',
              fix: async () => {
                const { installHookCommand } = await import('../../install-hook.js');
                await installHookCommand();
              },
              fixLabel: 'Reinstall hook',
            };
          }
        }

        return { id: 'hooks.binary_exists', label: 'Hook binary path', status: 'skip', detail: 'No code-insights hook found' };
      },
    },
    {
      id: 'hooks.binary_current',
      label: 'Hook binary current',
      run: async (): Promise<CheckResult> => {
        const settings = loadClaudeSettings();
        if (!settings?.hooks?.SessionEnd) {
          return { id: 'hooks.binary_current', label: 'Hook binary current', status: 'skip', detail: 'No SessionEnd hook' };
        }

        for (const hookConfig of settings.hooks.SessionEnd) {
          for (const hook of hookConfig.hooks) {
            const cmd = getHookCommand(hook);
            if (!cmd.includes('code-insights')) continue;
            const binPath = extractBinaryPath(cmd);
            if (!binPath) continue;
            const resolvedHook = path.resolve(binPath);
            const resolvedCurrent = path.resolve(CLI_ENTRY);
            if (resolvedHook === resolvedCurrent) {
              return { id: 'hooks.binary_current', label: 'Hook binary current', status: 'pass' };
            }
            return {
              id: 'hooks.binary_current',
              label: 'Hook binary current',
              status: 'fail',
              detail: `Hook: ${resolvedHook}\n                     Current: ${resolvedCurrent}`,
              hint: 'Run: code-insights install-hook\n           (rewrites hook to use current binary path)',
              fix: async () => {
                const { installHookCommand } = await import('../../install-hook.js');
                await installHookCommand();
              },
              fixLabel: 'Reinstall hook with current path',
            };
          }
        }

        return { id: 'hooks.binary_current', label: 'Hook binary current', status: 'skip' };
      },
    },
    {
      id: 'hooks.no_legacy_stop',
      label: 'No legacy Stop hook',
      run: async (): Promise<CheckResult> => {
        const settings = loadClaudeSettings();
        if (!settings?.hooks?.Stop) {
          return { id: 'hooks.no_legacy_stop', label: 'No legacy Stop hook', status: 'pass' };
        }
        const hasLegacy = settings.hooks.Stop.some(
          (h) => h.hooks.some((hook) => getHookCommand(hook).includes('code-insights'))
        );
        if (!hasLegacy) {
          return { id: 'hooks.no_legacy_stop', label: 'No legacy Stop hook', status: 'pass' };
        }
        return {
          id: 'hooks.no_legacy_stop',
          label: 'No legacy Stop hook',
          status: 'warn',
          detail: 'Legacy v4.8.x Stop hook found — it will be removed on next install-hook',
          hint: 'Run: code-insights install-hook (cleans up legacy hooks)',
        };
      },
    },
    {
      id: 'hooks.project_override',
      label: 'No project hook override',
      run: async (): Promise<CheckResult> => {
        const localSettings = path.join(process.cwd(), '.claude', 'settings.json');
        if (!fs.existsSync(localSettings)) {
          return { id: 'hooks.project_override', label: 'No project hook override', status: 'pass' };
        }
        try {
          const content = fs.readFileSync(localSettings, 'utf-8');
          const settings = JSON.parse(content);
          if (settings.hooks) {
            return {
              id: 'hooks.project_override',
              label: 'No project hook override',
              status: 'warn',
              detail: `${localSettings} has a hooks key — may shadow user-level hook`,
            };
          }
          return { id: 'hooks.project_override', label: 'No project hook override', status: 'pass' };
        } catch {
          return { id: 'hooks.project_override', label: 'No project hook override', status: 'pass' };
        }
      },
    },
  ];
}
