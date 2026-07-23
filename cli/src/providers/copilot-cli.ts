import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult, SessionUsage } from '../types.js';
import { generateTitle, detectSessionCharacter } from '../parser/titles.js';

/**
 * GitHub Copilot CLI session provider.
 * Discovers and parses events.jsonl files from ~/.copilot/session-state/
 */
export class CopilotCliProvider implements SessionProvider {
  getProviderName(): string {
    return 'copilot-cli';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const copilotHome = getCopilotHome();
    if (!copilotHome) return [];

    const files: string[] = [];

    // Walk session-state/ and history-session-state/ directories
    for (const subdir of ['session-state', 'history-session-state']) {
      const sessionsDir = path.join(copilotHome, subdir);
      collectEventsFiles(sessionsDir, files);
    }

    // Apply project filter if specified (filter by cwd from workspace.yaml)
    if (options?.projectFilter) {
      return filterByProject(files, options.projectFilter);
    }

    return files;
  }

  async parse(filePath: string): Promise<ParsedSession | null> {
    return parseCopilotSession(filePath);
  }
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

function getCopilotHome(): string | null {
  const envHome = process.env.COPILOT_HOME;
  if (envHome && fs.existsSync(envHome)) return envHome;

  const home = os.homedir();
  const defaultDir = path.join(home, '.copilot');
  return fs.existsSync(defaultDir) ? defaultDir : null;
}

/**
 * Collect events.jsonl files from session directories.
 * Structure: session-state/{session-id}/events.jsonl
 */
function collectEventsFiles(dir: string, files: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error: unknown) {
    // Missing optional roots mean "no history". Other failures make discovery
    // incomplete, so surface them instead of letting a migration treat a
    // partial file list as authoritative.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    const reason = error instanceof Error ? error.message : 'Unknown filesystem error';
    throw new Error(`Failed to discover Copilot CLI sessions in ${dir}: ${reason}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const eventsPath = path.join(dir, entry.name, 'events.jsonl');
    try {
      fs.statSync(eventsPath);
      files.push(eventsPath);
    } catch (error: unknown) {
      // A session directory without an events file (or one removed while
      // scanning) is not history. Permission and I/O failures are incomplete
      // discovery and must stop one-time migrations.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const reason = error instanceof Error ? error.message : 'Unknown filesystem error';
      throw new Error(`Failed to discover Copilot CLI session ${eventsPath}: ${reason}`);
    }
  }
}

/**
 * Quick-filter by project: read workspace.yaml sibling for cwd.
 */
function filterByProject(files: string[], projectFilter: string): string[] {
  const filtered: string[] = [];
  const lowerFilter = projectFilter.toLowerCase();

  for (const filePath of files) {
    try {
      const sessionDir = path.dirname(filePath);
      const workspacePath = path.join(sessionDir, 'workspace.yaml');

      if (fs.existsSync(workspacePath)) {
        const yamlContent = fs.readFileSync(workspacePath, 'utf-8');
        const meta = parseWorkspaceYaml(yamlContent);
        const cwd = meta.cwd || '';
        if (cwd.toLowerCase().includes(lowerFilter)) {
          filtered.push(filePath);
          continue;
        }
      }

      // If no workspace.yaml or no cwd match, try reading first line of events.jsonl
      // for session.start event with cwd
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(2048);
      const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);

      const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
      const event = JSON.parse(firstLine);
      const data = event.data || event;
      const cwd = data.cwd || '';
      if (cwd.toLowerCase().includes(lowerFilter)) {
        filtered.push(filePath);
      }
    } catch {
      // Include files we can't quick-check
      filtered.push(filePath);
    }
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// workspace.yaml parser (no YAML library — simple key: value)
// ---------------------------------------------------------------------------

function parseWorkspaceYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Copilot event types
// ---------------------------------------------------------------------------

interface CopilotEvent {
  type: string;
  data?: Record<string, unknown>;
  // Allow bare event format (forward compatibility)
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseCopilotSession(filePath: string): ParsedSession | null {
  try {
    const sessionDir = path.dirname(filePath);
    const sessionDirName = path.basename(sessionDir);

    // Read workspace.yaml for metadata (if present)
    const workspacePath = path.join(sessionDir, 'workspace.yaml');
    let workspaceMeta: Record<string, string> = {};
    if (fs.existsSync(workspacePath)) {
      workspaceMeta = parseWorkspaceYaml(fs.readFileSync(workspacePath, 'utf-8'));
    }

    // Read events.jsonl
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length === 0) return null;

    const sessionId = `copilot:${sessionDirName}`;
    let model = workspaceMeta.model || '';
    let cwd = workspaceMeta.cwd || '';
    let sessionName = workspaceMeta.name || '';

    // Parse events
    const messages: ParsedMessage[] = [];
    let lastTimestamp = fs.statSync(filePath).mtime;
    let firstTimestamp: Date | null = null;

    // Accumulator for current assistant turn
    let currentAssistantText = '';
    let currentAssistantId: string | null = null;
    let currentToolCalls: ToolCall[] = [];
    let currentToolResults: ToolResult[] = [];
    let toolCounter = 0;

    function flushAssistantTurn(): void {
      const text = currentAssistantText.trim();
      if (!text && currentToolCalls.length === 0) {
        currentAssistantId = null;
        return;
      }

      messages.push({
        id: currentAssistantId || generatedEntityId(sessionId, 'assistant', messages.length),
        sessionId: sessionId,
        type: 'assistant',
        content: text.slice(0, 10000),
        thinking: null,
        toolCalls: [...currentToolCalls],
        toolResults: [...currentToolResults],
        usage: null,
        timestamp: lastTimestamp,
        parentId: null,
      });

      // Reset accumulators
      currentAssistantText = '';
      currentAssistantId = null;
      currentToolCalls = [];
      currentToolResults = [];
    }

    for (const [lineIndex, line] of lines.entries()) {
      let event: CopilotEvent;
      try {
        event = JSON.parse(line) as CopilotEvent;
      } catch {
        // Sync treats this file as a complete replaceable snapshot. Reject even
        // a malformed final line; a later sync can retry after the writer closes it.
        throw new Error(`Malformed Copilot event at line ${lineIndex + 1}: ${filePath}`);
      }

      // Extract timestamp from event root first (Copilot CLI stores timestamp at
      // the envelope level, not inside data). parseTimestamp checks .timestamp,
      // .createdAt, and .time, so this handles both root and nested formats.
      const rootTs = parseTimestamp(event as unknown as Record<string, unknown>);
      if (rootTs) {
        lastTimestamp = rootTs;
        if (!firstTimestamp) firstTimestamp = rootTs;
      }

      // Unwrap envelope: support both {type, data} and bare event formats
      const eventType = event.type;
      const data = (event.data || event) as Record<string, unknown>;

      // Also check data-level timestamp — takes precedence over root-level if present,
      // since data fields are more specific to the event than the envelope.
      const dataTs = parseTimestamp(data);
      if (dataTs) {
        lastTimestamp = dataTs;
        if (!firstTimestamp) firstTimestamp = dataTs;
      }

      switch (eventType) {
        case 'session.start': {
          // Extract session metadata
          if (!cwd && data.cwd) cwd = data.cwd as string;
          if (!model && data.model) model = data.model as string;
          if (!sessionName && data.name) sessionName = data.name as string;
          break;
        }

        case 'user.message': {
          // Flush any pending assistant turn
          flushAssistantTurn();

          const userContent = extractText(data);
          if (userContent) {
            const sourceId = toSourceId(data.id);
            messages.push({
              id: sourceId
                ? scopedSourceId(sessionId, 'user', sourceId)
                : generatedEntityId(sessionId, 'user', messages.length),
              sessionId: sessionId,
              type: 'user',
              content: userContent.slice(0, 10000),
              thinking: null,
              toolCalls: [],
              toolResults: [],
              usage: null,
              timestamp: lastTimestamp,
              parentId: null,
            });
          }
          break;
        }

        case 'assistant.message': {
          const sourceId = toSourceId(data.id);
          if (!currentAssistantId && sourceId) {
            currentAssistantId = scopedSourceId(sessionId, 'assistant', sourceId);
          }
          const text = extractText(data);
          if (text) {
            currentAssistantText += text + '\n';
          }
          // Extract tool calls from toolRequests array — this gives canonical IDs
          // from the assistant turn, before tool.execution_start fires separately.
          const toolRequests = data.toolRequests as Array<Record<string, unknown>> | undefined;
          if (toolRequests) {
            for (const tr of toolRequests) {
              const sourceId = toSourceId(tr.toolCallId);
              const tcId = sourceId
                ? scopedSourceId(sessionId, 'tool', sourceId)
                : generatedEntityId(sessionId, 'tool', ++toolCounter);
              const tcName = (tr.name as string) || 'unknown_tool';
              let tcInput: Record<string, unknown> = {};
              if (typeof tr.arguments === 'string') {
                try {
                  tcInput = JSON.parse(tr.arguments);
                } catch {
                  tcInput = { raw: tr.arguments };
                }
              } else if (tr.arguments && typeof tr.arguments === 'object') {
                tcInput = tr.arguments as Record<string, unknown>;
              }
              currentToolCalls.push({ id: tcId, name: tcName, input: tcInput });
            }
          }
          break;
        }

        case 'assistant.message_delta': {
          const sourceId = toSourceId(data.id);
          if (!currentAssistantId && sourceId) {
            currentAssistantId = scopedSourceId(sessionId, 'assistant', sourceId);
          }
          const delta = (data.delta as string) || (data.text as string) || '';
          if (delta) {
            currentAssistantText += delta;
          }
          break;
        }

        case 'tool.execution_start': {
          // Prefer the canonical toolCallId, with data.id for older event formats.
          const sourceId = toSourceId(data.toolCallId) || toSourceId(data.id);
          const toolCallId = sourceId
            ? scopedSourceId(sessionId, 'tool', sourceId)
            : null;
          // Skip if already tracked from assistant.message toolRequests to avoid duplicates
          if (toolCallId && currentToolCalls.some(tc => tc.id === toolCallId)) {
            break;
          }
          toolCounter++;
          const toolName = (data.toolName as string) || (data.name as string) || 'unknown_tool';
          const toolInput = (data.parameters || data.arguments || {}) as Record<string, unknown>;
          currentToolCalls.push({
            id: toolCallId || generatedEntityId(sessionId, 'tool', toolCounter),
            name: toolName,
            input: toolInput,
          });
          break;
        }

        case 'tool.execution_complete': {
          // Extract model info if present in tool completion events
          if (!model && data.model) {
            model = data.model as string;
          }
          // data.result may be an object like {content: "..."} or a plain string
          const rawResult = data.result;
          let toolOutput: string;
          if (typeof rawResult === 'string') {
            toolOutput = rawResult;
          } else if (rawResult && typeof rawResult === 'object') {
            const resultObj = rawResult as Record<string, unknown>;
            toolOutput = (resultObj.content as string) || JSON.stringify(rawResult);
          } else {
            toolOutput = (data.output as string) || '';
          }
          const sourceId = toSourceId(data.toolCallId) || toSourceId(data.id);
          const toolId = sourceId
            ? scopedSourceId(sessionId, 'tool', sourceId)
            : (currentToolCalls.length > 0
                ? currentToolCalls[currentToolCalls.length - 1].id
                : generatedEntityId(sessionId, 'tool', toolCounter));
          if (toolOutput) {
            currentToolResults.push({
              toolUseId: toolId,
              output: toolOutput.slice(0, 1000),
            });
          }
          break;
        }

        case 'subagent.started': {
          toolCounter++;
          const agentName = (data.name as string) || (data.agentName as string) || 'subagent';
          const sourceId = toSourceId(data.id);
          currentToolCalls.push({
            id: sourceId
              ? scopedSourceId(sessionId, 'subagent', sourceId)
              : generatedEntityId(sessionId, 'subagent', toolCounter),
            name: `subagent:${agentName}`,
            input: (data.parameters || data.arguments || data.input || {}) as Record<string, unknown>,
          });
          break;
        }

        case 'subagent.completed': {
          const agentOutput = (data.output as string) || (data.result as string) || '';
          const sourceId = toSourceId(data.id);
          const agentId = sourceId
            ? scopedSourceId(sessionId, 'subagent', sourceId)
            : (currentToolCalls.length > 0
                ? currentToolCalls[currentToolCalls.length - 1].id
                : generatedEntityId(sessionId, 'subagent', toolCounter));
          if (agentOutput) {
            currentToolResults.push({
              toolUseId: agentId,
              output: agentOutput.slice(0, 1000),
            });
          }
          break;
        }

        case 'session.idle': {
          // Turn boundary — flush accumulated assistant turn
          flushAssistantTurn();
          break;
        }

        default:
          // Skip unknown event types gracefully
          break;
      }
    }

    // Flush any remaining assistant content
    flushAssistantTurn();

    if (messages.length === 0) return null;

    // Build session
    const userMessages = messages.filter(m => m.type === 'user');
    const assistantMessages = messages.filter(m => m.type === 'assistant');
    const toolCallCount = messages.reduce((sum, m) => sum + m.toolCalls.length, 0);

    const timestamps = messages.map(m => m.timestamp.getTime()).filter(t => t > 0);
    const startedAt = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : (firstTimestamp || new Date());
    const endedAt = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : lastTimestamp;

    const projectPath = cwd || 'copilot://unknown';
    const projectName = sessionName || path.basename(projectPath);

    // Build usage object if model info was extracted from events.
    // write.ts reads session.usage?.modelsUsed and session.usage?.primaryModel,
    // so without this the model columns stay null in SQLite.
    const sessionUsage: SessionUsage | undefined = model
      ? {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCostUsd: 0,
          modelsUsed: [model],
          primaryModel: model,
          usageSource: 'session',
        }
      : undefined;

    const session: ParsedSession = {
      id: sessionId,
      projectPath,
      projectName,
      summary: null,
      generatedTitle: null,
      titleSource: null,
      sessionCharacter: null,
      startedAt,
      endedAt,
      messageCount: userMessages.length + assistantMessages.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolCallCount,
      compactCount: 0,
      autoCompactCount: 0,
      slashCommands: [],
      gitBranch: null,
      claudeVersion: model || null,
      sourceTool: 'copilot-cli',
      usage: sessionUsage,
      messages,
    };

    // Generate title and character
    const titleResult = generateTitle(session);
    session.generatedTitle = titleResult.title;
    session.titleSource = titleResult.source;
    session.sessionCharacter = titleResult.character || detectSessionCharacter(session);

    return session;
  } catch (error) {
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function extractText(data: Record<string, unknown>): string | null {
  if (typeof data.text === 'string') return data.text;
  if (typeof data.content === 'string') return data.content;
  if (typeof data.message === 'string') return data.message;
  if (Array.isArray(data.content)) {
    return (data.content as Array<Record<string, string>>)
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return null;
}

function parseTimestamp(data: Record<string, unknown>): Date | null {
  const ts = data.timestamp || data.createdAt || data.time;
  if (!ts) return null;
  const d = new Date(ts as string | number);
  return isNaN(d.getTime()) ? null : d;
}

type CopilotEntity = 'user' | 'assistant' | 'tool' | 'subagent';

function toSourceId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const sourceId = String(value);
  return sourceId ? sourceId : null;
}

function scopedSourceId(sessionId: string, entity: CopilotEntity, sourceId: string): string {
  return `${sessionId}:${entity}:source:${sourceId}`;
}

function generatedEntityId(sessionId: string, entity: CopilotEntity, ordinal: number): string {
  return `${sessionId}:${entity}:generated:${ordinal}`;
}
