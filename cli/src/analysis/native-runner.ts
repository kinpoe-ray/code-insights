/**
 * ClaudeNativeRunner — executes analysis via `claude -p` (non-interactive mode).
 *
 * Uses execFileSync (NOT exec) to prevent shell injection: arguments are passed
 * as an array, never interpolated into a shell command string.
 *
 * Token counts are 0 because native-mode tokens are counted as part of the
 * overall Claude Code session — Code Insights incurs no separate cost.
 */

import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from './runner-types.js';

// Current Claude versions return a single result object for `--output-format
// json`; older versions returned an array of typed event objects. Support both.
interface ClaudeEvent {
  type: string;
  subtype?: string;
}

interface ClaudeResultEvent extends ClaudeEvent {
  type: 'result';
  subtype?: string;
  result?: unknown;
  errors?: unknown;
  is_error?: boolean;
  structured_output?: unknown;
}

class ClaudeReportedError extends Error {}

function isClaudeEvent(value: unknown): value is ClaudeEvent {
  return typeof value === 'object' && value !== null && 'type' in value &&
    typeof (value as { type?: unknown }).type === 'string';
}

function isResultEvent(value: unknown): value is ClaudeResultEvent {
  return isClaudeEvent(value) && value.type === 'result';
}

function isErrorResult(event: ClaudeResultEvent): boolean {
  return event.is_error === true ||
    (typeof event.subtype === 'string' && event.subtype.startsWith('error_'));
}

function formatClaudeError(event: ClaudeResultEvent): string {
  const errors = Array.isArray(event.errors)
    ? event.errors.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : [];
  if (errors.length === 0 && typeof event.result === 'string' && event.result.trim() !== '') {
    errors.push(event.result);
  }

  const subtype = typeof event.subtype === 'string' && event.subtype.trim() !== ''
    ? ` (${event.subtype})`
    : '';
  const detail = errors.length > 0 ? `: ${errors.join('; ')}` : '';
  return `claude -p reported an error${subtype}${detail}`;
}

function getCapturedOutput(error: unknown, field: 'stdout' | 'stderr'): string | null {
  if (typeof error !== 'object' || error === null || !(field in error)) return null;
  const value = (error as Record<'stdout' | 'stderr', unknown>)[field];
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return null;
}

/**
 * Extract the LLM text payload from a `claude -p --output-format json` response.
 * The actual content lives in the result object's `result` field. When a JSON
 * schema is supplied, current Claude versions also provide the validated value
 * in `structured_output`; prefer that value over free-form result text.
 */
function extractResultFromEnvelope(rawOutput: string): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawOutput) as unknown;
  } catch {
    throw new Error(
      `claude -p returned non-JSON output. Output preview: ${rawOutput.slice(0, 200)}`
    );
  }

  const events = Array.isArray(envelope) ? envelope : [envelope];
  const resultEvent = events.find(isResultEvent);
  if (!resultEvent) {
    const eventTypes = events.filter(isClaudeEvent).map(event => event.type);
    throw new Error('claude -p output contained no result event. Events: ' + JSON.stringify(eventTypes));
  }

  if (isErrorResult(resultEvent)) {
    throw new ClaudeReportedError(formatClaudeError(resultEvent));
  }

  if (resultEvent.structured_output !== undefined) {
    return JSON.stringify(resultEvent.structured_output);
  }

  if (typeof resultEvent.result !== 'string') {
    throw new Error('claude -p result event did not contain a string result.');
  }

  return resultEvent.result;
}

/** Default model used by ClaudeNativeRunner when --model is not specified. */
export const DEFAULT_NATIVE_MODEL = 'sonnet';

export class ClaudeNativeRunner implements AnalysisRunner {
  readonly name = 'claude-code-native';
  private readonly model: string;

  constructor(options?: { model?: string }) {
    this.model = options?.model ?? DEFAULT_NATIVE_MODEL;
  }

  /**
   * Validate that the `claude` CLI is available in PATH.
   * Call this once before running analysis to give the user a clear error
   * instead of a cryptic ENOENT from execFileSync.
   */
  static validate(): void {
    try {
      execFileSync('claude', ['--version'], { stdio: 'pipe' });
    } catch {
      throw new Error(
        'claude CLI not found in PATH. --native requires Claude Code to be installed.\n' +
        'Install it from: https://claude.ai/download'
      );
    }
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const start = Date.now();
    // Include a random suffix to avoid collisions if two analyses run concurrently.
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Write system prompt to a temp file — claude -p reads it via --append-system-prompt-file.
    // Temp file avoids command-line length limits and shell escaping issues.
    const promptFile = join(tmpdir(), `ci-prompt-${fileId}.txt`);
    writeFileSync(promptFile, params.systemPrompt, 'utf-8');

    try {
      const args = [
        '-p',
        '--model', this.model,
        '--output-format', 'json',
        '--append-system-prompt-file', promptFile,
      ];
      if (params.jsonSchema) {
        // Claude Code expects the schema JSON itself, not a path to a file.
        args.push('--json-schema', JSON.stringify(params.jsonSchema));
      }

      let rawOutput: string;
      try {
        rawOutput = execFileSync('claude', args, {
          input: params.userPrompt,
          encoding: 'utf-8',
          timeout: 300_000,    // 5-minute hard limit per analysis call
          maxBuffer: 10 * 1024 * 1024,  // 10 MB
          cwd: tmpdir(),       // Isolate claude -p session files from user's project
          // Propagate CODE_INSIGHTS_HOOK_ACTIVE so the claude -p subprocess won't
          // trigger another SessionEnd hook when its own session ends (breaks the loop).
          env: { ...process.env, CODE_INSIGHTS_HOOK_ACTIVE: '1' },
        });
      } catch (error) {
        // Claude Code 2.1.168 writes its JSON result to stdout even when the
        // process exits non-zero. Recover the structured error before falling
        // back to Node's generic "Command failed" exception.
        const stdout = getCapturedOutput(error, 'stdout');
        if (stdout?.trim()) {
          try {
            extractResultFromEnvelope(stdout);
          } catch (responseError) {
            if (responseError instanceof ClaudeReportedError) throw responseError;
          }
        }
        throw error;
      }

      // Extract the LLM payload from either the current single-result response
      // or the legacy event-array envelope.
      const rawJson = extractResultFromEnvelope(rawOutput);

      return {
        rawJson,
        durationMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        model: this.model,
        provider: 'claude-code-native',
      };
    } finally {
      // Always clean up temp files, even if execFileSync throws.
      try { unlinkSync(promptFile); } catch { /* ignore — file may not exist */ }
    }
  }
}
