import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CopilotCliProvider } from './copilot-cli.js';

function writeSession(root: string, name: string): string {
  const sessionDir = path.join(root, name);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, 'events.jsonl');
  const events = [
    {
      type: 'session.start',
      timestamp: '2026-07-23T10:00:00.000Z',
      data: { cwd: '/workspace/project' },
    },
    {
      type: 'user.message',
      timestamp: '2026-07-23T10:00:01.000Z',
      data: { text: 'Inspect the project' },
    },
    {
      type: 'assistant.message',
      timestamp: '2026-07-23T10:00:02.000Z',
      data: {
        text: 'Inspection complete',
        toolRequests: [{ name: 'read_file', arguments: '{}' }],
      },
    },
    {
      type: 'session.idle',
      timestamp: '2026-07-23T10:00:03.000Z',
      data: {},
    },
  ];
  fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join('\n'));
  return filePath;
}

function writeSessionWithSourceIds(root: string, name: string): string {
  const sessionDir = path.join(root, name);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, 'events.jsonl');
  const events = [
    {
      type: 'session.start',
      timestamp: '2026-07-23T10:00:00.000Z',
      data: { cwd: '/workspace/project' },
    },
    {
      type: 'user.message',
      timestamp: '2026-07-23T10:00:01.000Z',
      data: { id: 'shared-user-id', text: 'Inspect the project' },
    },
    {
      type: 'assistant.message',
      timestamp: '2026-07-23T10:00:02.000Z',
      data: { id: 'shared-assistant-id', text: 'Inspection complete' },
    },
    {
      type: 'session.idle',
      timestamp: '2026-07-23T10:00:03.000Z',
      data: {},
    },
  ];
  fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join('\n'));
  return filePath;
}

function writeSessionWithSourceToolIds(root: string, name: string): string {
  const sessionDir = path.join(root, name);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, 'events.jsonl');
  const events = [
    {
      type: 'session.start',
      timestamp: '2026-07-23T10:00:00.000Z',
      data: { cwd: '/workspace/project' },
    },
    {
      type: 'assistant.message',
      timestamp: '2026-07-23T10:00:01.000Z',
      data: { text: 'Using tools' },
    },
    {
      type: 'tool.execution_start',
      timestamp: '2026-07-23T10:00:02.000Z',
      data: { id: 'shared-tool-id', toolName: 'read_file', parameters: {} },
    },
    {
      type: 'tool.execution_complete',
      timestamp: '2026-07-23T10:00:03.000Z',
      data: { id: 'shared-tool-id', result: 'done' },
    },
    {
      type: 'subagent.started',
      timestamp: '2026-07-23T10:00:04.000Z',
      data: { id: 'shared-subagent-id', name: 'reviewer' },
    },
    {
      type: 'subagent.completed',
      timestamp: '2026-07-23T10:00:05.000Z',
      data: { id: 'shared-subagent-id', result: 'reviewed' },
    },
    {
      type: 'session.idle',
      timestamp: '2026-07-23T10:00:06.000Z',
      data: {},
    },
  ];
  fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join('\n'));
  return filePath;
}

describe('CopilotCliProvider session-scoped identifiers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cli-provider-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps generated message IDs disjoint across sessions', async () => {
    const firstPath = writeSession(tempDir, 'session-a');
    const secondPath = writeSession(tempDir, 'session-b');
    const provider = new CopilotCliProvider();

    const first = await provider.parse(firstPath);
    const second = await provider.parse(secondPath);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const firstIds = new Set(first!.messages.map(message => message.id));
    const overlap = second!.messages
      .map(message => message.id)
      .filter(id => firstIds.has(id));
    expect(overlap).toEqual([]);
  });

  it('keeps generated tool-call IDs disjoint across sessions', async () => {
    const firstPath = writeSession(tempDir, 'session-a');
    const secondPath = writeSession(tempDir, 'session-b');
    const provider = new CopilotCliProvider();

    const first = await provider.parse(firstPath);
    const second = await provider.parse(secondPath);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const firstIds = new Set(
      first!.messages.flatMap(message => message.toolCalls.map(toolCall => toolCall.id)),
    );
    const overlap = second!.messages
      .flatMap(message => message.toolCalls.map(toolCall => toolCall.id))
      .filter(id => firstIds.has(id));
    expect(overlap).toEqual([]);
  });

  it('scopes source message IDs to the session and keeps them stable', async () => {
    const firstPath = writeSessionWithSourceIds(tempDir, 'session-a');
    const secondPath = writeSessionWithSourceIds(tempDir, 'session-b');
    const provider = new CopilotCliProvider();

    const first = await provider.parse(firstPath);
    const firstAgain = await provider.parse(firstPath);
    const second = await provider.parse(secondPath);

    expect(first).not.toBeNull();
    expect(firstAgain).not.toBeNull();
    expect(second).not.toBeNull();
    expect(firstAgain!.messages.map(message => message.id))
      .toEqual(first!.messages.map(message => message.id));

    const firstIds = new Set(first!.messages.map(message => message.id));
    expect(second!.messages.map(message => message.id).filter(id => firstIds.has(id))).toEqual([]);
    expect(first!.messages.every(message => message.id.startsWith(`${first!.id}:`))).toBe(true);
    expect(second!.messages.every(message => message.id.startsWith(`${second!.id}:`))).toBe(true);
    expect(firstIds).toContain(`${first!.id}:user:source:shared-user-id`);
    expect(firstIds).toContain(`${first!.id}:assistant:source:shared-assistant-id`);
  });

  it('scopes source tool and subagent IDs while preserving result references', async () => {
    const firstPath = writeSessionWithSourceToolIds(tempDir, 'session-a');
    const secondPath = writeSessionWithSourceToolIds(tempDir, 'session-b');
    const provider = new CopilotCliProvider();

    const first = await provider.parse(firstPath);
    const firstAgain = await provider.parse(firstPath);
    const second = await provider.parse(secondPath);

    expect(first).not.toBeNull();
    expect(firstAgain).not.toBeNull();
    expect(second).not.toBeNull();

    const idsFor = (session: NonNullable<typeof first>) =>
      session.messages.flatMap(message => message.toolCalls.map(toolCall => toolCall.id));
    expect(idsFor(firstAgain!)).toEqual(idsFor(first!));

    const firstIds = new Set(idsFor(first!));
    expect(idsFor(second!).filter(id => firstIds.has(id))).toEqual([]);
    expect(idsFor(first!).every(id => id.startsWith(`${first!.id}:`))).toBe(true);
    expect(idsFor(second!).every(id => id.startsWith(`${second!.id}:`))).toBe(true);
    expect(firstIds).toContain(`${first!.id}:tool:source:shared-tool-id`);
    expect(firstIds).toContain(`${first!.id}:subagent:source:shared-subagent-id`);

    for (const session of [first!, second!]) {
      for (const message of session.messages) {
        const toolCallIds = new Set(message.toolCalls.map(toolCall => toolCall.id));
        expect(message.toolResults.every(result => toolCallIds.has(result.toolUseId))).toBe(true);
      }
    }
  });

  it('rejects a malformed non-tail event instead of returning a partial snapshot', async () => {
    const sessionDir = path.join(tempDir, 'malformed-session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, 'events.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: 'user.message',
        timestamp: '2026-07-23T10:00:01.000Z',
        data: { text: 'First complete event' },
      }),
      '{"type":"assistant.message","data":',
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-07-23T10:00:02.000Z',
        data: { text: 'Later complete event' },
      }),
    ].join('\n'));

    const provider = new CopilotCliProvider();

    await expect(provider.parse(filePath)).rejects.toThrow(/malformed Copilot event.*line 2/i);
  });
});

describe('CopilotCliProvider discovery completeness', () => {
  let tempDir: string;
  let originalCopilotHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cli-discovery-'));
    originalCopilotHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = tempDir;
  });

  afterEach(() => {
    if (originalCopilotHome === undefined) {
      delete process.env.COPILOT_HOME;
    } else {
      process.env.COPILOT_HOME = originalCopilotHome;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects partial discovery when one existing session root cannot be read', async () => {
    const activeRoot = path.join(tempDir, 'session-state');
    const activeSession = writeSession(activeRoot, 'active-session');
    const historyRoot = path.join(tempDir, 'history-session-state');
    fs.writeFileSync(historyRoot, 'not a directory');

    const provider = new CopilotCliProvider();

    await expect(provider.discover()).rejects.toThrow(/discover Copilot CLI sessions/i);

    fs.rmSync(historyRoot);
    const historySession = writeSession(historyRoot, 'history-session');
    await expect(provider.discover()).resolves.toEqual([activeSession, historySession]);
  });

  it('treats missing or empty optional session roots as no history', async () => {
    const provider = new CopilotCliProvider();

    await expect(provider.discover()).resolves.toEqual([]);

    fs.mkdirSync(path.join(tempDir, 'session-state'));
    fs.mkdirSync(path.join(tempDir, 'history-session-state'));
    fs.mkdirSync(path.join(tempDir, 'session-state', 'unfinished-session'));
    await expect(provider.discover()).resolves.toEqual([]);
  });
});
