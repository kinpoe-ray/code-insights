import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockOs = { homeDir: '' };

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: () => mockOs.homeDir,
  };
});

let mockHomeDir: string;

beforeEach(() => {
  mockHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-doctor-hook-test-'));
  mockOs.homeDir = mockHomeDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(mockHomeDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function writeHook(command: string): void {
  const settingsDir = path.join(mockHomeDir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 10000 }] }],
      },
    }),
  );
}

async function runHookCheck(id: string) {
  const { hooksChecks } = await import('./hooks.js');
  const check = hooksChecks().find((candidate) => candidate.id === id);
  if (!check) throw new Error(`Missing hook check: ${id}`);
  return check.run();
}

describe('doctor hook binary path parsing', () => {
  it.each([
    (binaryPath: string) => `node '${binaryPath}' session-end --native -q`,
    (binaryPath: string) => `CODE_INSIGHTS_CONFIG_DIR='/tmp/custom config' node "${binaryPath}" session-end --native -q`,
    (binaryPath: string) => `env CODE_INSIGHTS_CONFIG_DIR='/tmp/custom config' node '${binaryPath}' session-end --native -q`,
    (binaryPath: string) => `set "CODE_INSIGHTS_CONFIG_DIR=C:\\custom config" && node "${binaryPath}" session-end --native -q`,
  ])('recognizes a quoted CLI path after optional environment prefixes', async (commandFor) => {
    const binaryDir = path.join(mockHomeDir, 'code-insights with spaces');
    const binaryPath = path.join(binaryDir, 'index.js');
    fs.mkdirSync(binaryDir, { recursive: true });
    fs.writeFileSync(binaryPath, '#!/usr/bin/env node\n');
    writeHook(commandFor(binaryPath));

    const result = await runHookCheck('hooks.binary_exists');

    expect(result).toMatchObject({ status: 'pass', detail: binaryPath });
  });

  it('does not mark the quoted path emitted by install-hook as stale', async () => {
    const { CLI_ENTRY } = await import('../../../utils/hooks-utils.js');
    writeHook(`CODE_INSIGHTS_CONFIG_DIR='/tmp/custom config' node '${CLI_ENTRY}' session-end --native -q`);

    const result = await runHookCheck('hooks.binary_current');

    expect(result).toMatchObject({ status: 'pass' });
  });

  it('preserves Windows path separators inside a double-quoted CLI path', async () => {
    const binaryPath = path.join(mockHomeDir, 'code-insights\\Program Files\\index.js');
    fs.writeFileSync(binaryPath, '#!/usr/bin/env node\n');
    writeHook(`set "CODE_INSIGHTS_CONFIG_DIR=C:\\custom config" && node "${binaryPath}" session-end --native -q`);

    const result = await runHookCheck('hooks.binary_exists');

    expect(result).toMatchObject({ status: 'pass', detail: binaryPath });
  });
});
