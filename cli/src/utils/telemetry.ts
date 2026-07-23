import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import chalk from 'chalk';
import { PostHog } from 'posthog-node';
import { loadConfig, getConfigDir } from './config.js';

// PostHog write-only API key (public — this is the standard PostHog pattern;
// write-only keys can only ingest events, not read data).
const POSTHOG_API_KEY = 'phc_552ZSApq5xuagswylfdw2vx8nckm31jn6LCpTVyVn8j';
const POSTHOG_HOST = 'https://us.i.posthog.com';

// Touch file path that tracks whether the disclosure has been shown.
// Content is the CLI version — if version doesn't match current, notice is re-shown.
const NOTICE_FILE = path.join(getConfigDir(), '.telemetry-notice-shown');

// Exhaustive list of event names — string literal union for autocomplete + typo prevention.
export type TelemetryEventName =
  | 'cli_sync'
  | 'cli_stats'
  | 'cli_dashboard'
  | 'cli_init'
  | 'cli_config'
  | 'cli_reset'
  | 'cli_install_hook'
  | 'cli_status'
  | 'cli_open'
  | 'analysis_run'
  | 'insight_generated'
  | 'export_run'
  | 'dashboard_loaded'
  | 'telemetry_opted_out'
  | 'telemetry_opted_in'
  | 'migration_v6_resync';

// PostHog client — lazily initialized on first trackEvent call.
// null when telemetry is disabled or init hasn't happened yet.
let client: PostHog | null = null;

// Only aggregate, product-owned fields may cross the telemetry boundary.
// Free-form errors, responses, paths, prompts, and caller-defined context are
// intentionally absent from this list.
const TELEMETRY_PROPERTY_ALLOWLIST = new Set([
  'success',
  'duration_ms',
  'sessions_synced',
  'sessions_by_provider',
  'errors',
  'source_filter',
  'subcommand',
  'period',
  'port',
  'error_type',
  'command',
  'hook_types',
  'sync_installed',
  'analysis_installed',
  'sessions_recalculated',
  'insight_count',
  'type',
  'count',
  'format',
  'template',
  'session_count',
  'scope',
  'depth',
  'llm_provider',
  'llm_model',
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'cost_usd',
]);

const SAFE_TELEMETRY_STRING = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,119}$/;
const SENSITIVE_TELEMETRY_STRING = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/i,
  /(?:^|[\s("'`])\/(?:Users|home|private|tmp|var|Volumes|etc|opt)\//i,
  /[A-Za-z]:\\(?:Users|Documents and Settings|Windows)\\/i,
  /\bat\s+.+:\d+:\d+\)?/i,
  /\b(?:bearer|password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]/i,
  /\b(?:sk|ghp|phc)_[A-Za-z0-9_-]{8,}\b/i,
];

function sanitizeTelemetryString(value: string): string | undefined {
  if (!SAFE_TELEMETRY_STRING.test(value)) return undefined;
  if (SENSITIVE_TELEMETRY_STRING.some((pattern) => pattern.test(value))) return undefined;
  return value;
}

function sanitizeTelemetryProperties(
  properties?: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties ?? {})) {
    if (!TELEMETRY_PROPERTY_ALLOWLIST.has(key) || value === undefined) continue;

    if (value === null || typeof value === 'boolean') {
      sanitized[key] = value;
      continue;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value;
      continue;
    }

    if (typeof value === 'string') {
      const safeValue = sanitizeTelemetryString(value);
      if (safeValue !== undefined) sanitized[key] = safeValue;
      continue;
    }

    if (
      key === 'sessions_by_provider'
      && typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
    ) {
      const counts: Record<string, number> = {};
      for (const [provider, count] of Object.entries(value)) {
        const safeProvider = sanitizeTelemetryString(provider);
        if (safeProvider !== undefined && typeof count === 'number' && Number.isFinite(count)) {
          counts[safeProvider] = count;
        }
      }
      sanitized[key] = counts;
    }
  }

  return sanitized;
}

/**
 * Check if telemetry is enabled.
 *
 * Check order (first match wins):
 * 1. CODE_INSIGHTS_TELEMETRY_DISABLED=1 env var — respects CI/automation opt-out
 * 2. DO_NOT_TRACK=1 env var — respects the community standard
 * 3. config.telemetry field — user's explicit preference
 * 4. Default: true (opt-out model)
 */
export function isTelemetryEnabled(): boolean {
  if (process.env.CODE_INSIGHTS_TELEMETRY_DISABLED === '1') return false;
  if (process.env.DO_NOT_TRACK === '1') return false;

  const config = loadConfig();
  if (config !== null && typeof config.telemetry === 'boolean') {
    return config.telemetry;
  }

  return true;
}

/**
 * Get (or lazily create) the PostHog client.
 * Returns null when telemetry is disabled.
 *
 * flushAt: 1 — flush immediately after each capture(); CLI is short-lived
 * flushInterval: 0 — no background timer; avoids keeping process alive
 */
function getPostHogClient(): PostHog | null {
  if (!isTelemetryEnabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

/**
 * Flush and shut down the PostHog client.
 * Call this in server SIGINT/SIGTERM handlers before process.exit().
 * No-op if telemetry is disabled or client was never initialized.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}

/**
 * Show the telemetry disclosure notice if it hasn't been shown for this CLI version.
 *
 * Uses a version-stamped touch file at ~/.code-insights/.telemetry-notice-shown.
 * Re-shown when the CLI version changes (catches existing users on upgrades).
 * Only displays if telemetry is enabled.
 *
 * Returns true if the notice was shown.
 */
export function showTelemetryNoticeIfNeeded(): boolean {
  if (!isTelemetryEnabled()) return false;

  const currentVersion = getCliVersion();
  let shownVersion: string | null = null;

  if (fs.existsSync(NOTICE_FILE)) {
    try {
      shownVersion = fs.readFileSync(NOTICE_FILE, 'utf-8').trim();
    } catch {
      // Can't read — treat as not shown
    }
  }

  if (shownVersion === currentVersion) return false;

  // Show a condensed single-line disclosure
  console.log(chalk.dim('  Telemetry enabled · Disable: code-insights telemetry disable'));

  // Write the current version as content — best-effort, non-fatal
  try {
    const configDir = getConfigDir();
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(NOTICE_FILE, currentVersion, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Non-fatal — if we can't write, we'll show the notice again next time
  }

  return true;
}

/**
 * Classify an error into a structured error_type + error_message pair.
 * Used to enrich trackEvent calls and captureError calls with consistent error metadata.
 */
export function classifyError(error: unknown): { error_type: string; error_message: string } {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { error_type: 'abort', error_message: error.message };
    }
    // SyntaxError from JSON.parse
    if (error instanceof SyntaxError) {
      return { error_type: 'json_parse_error', error_message: error.message };
    }
    return { error_type: 'api_error', error_message: error.message };
  }
  return { error_type: 'unknown', error_message: String(error) };
}

/**
 * Capture an exception in PostHog. Never throws — telemetry must never break the CLI.
 * Respects the same opt-out as trackEvent.
 *
 * @param error - The caught error (or unknown value)
 * @param properties - Additional context properties (provider, model, etc.)
 */
export function captureError(error: unknown, properties?: Record<string, unknown>): void {
  const ph = getPostHogClient();
  if (!ph) return;

  try {
    const { error_type } = classifyError(error);
    const exceptionType = error instanceof Error ? error.constructor.name : error_type;
    const safeExceptionType = sanitizeTelemetryString(exceptionType) ?? 'Error';

    ph.capture({
      distinctId: getStableMachineId(),
      event: '$exception',
      properties: {
        ...sanitizeTelemetryProperties({ ...properties, error_type }),
        $exception_type: safeExceptionType,
      },
    });
  } catch {
    // Swallow all errors — telemetry failures are silent
  }
}

/**
 * Send a telemetry event. Never throws — telemetry must never break the CLI.
 *
 * @param event - Event name from TelemetryEventName union
 * @param properties - Arbitrary event properties (success, duration_ms, etc.)
 */
export function trackEvent(event: TelemetryEventName, properties?: Record<string, unknown>): void {
  const ph = getPostHogClient();
  if (!ph) return;

  try {
    ph.capture({
      distinctId: getStableMachineId(),
      event,
      properties: sanitizeTelemetryProperties(properties),
    });
  } catch {
    // Swallow all errors — telemetry failures are silent
  }
}

/**
 * Set person-level properties via PostHog identify().
 * Call once after the DB is open (so total_sessions can be queried).
 *
 * Commands that never open the DB (init, config, telemetry) can skip this —
 * PostHog retains person properties from previous calls.
 */
export async function identifyUser(): Promise<void> {
  const ph = getPostHogClient();
  if (!ph) return;

  try {
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };

    ph.identify({
      distinctId: getStableMachineId(),
      properties: {
        cli_version: getCliVersion(),
        node_version: process.version.replace('v', ''),
        os: process.platform,
        arch: process.arch,
        installed_providers: detectProviders(),
        has_hook: detectHook(),
        total_sessions: row.count,
      },
    });
  } catch {
    // Non-fatal — identify failure doesn't affect event tracking
  }
}

/**
 * Build a preview of what would be collected and sent.
 * Used by `code-insights telemetry status` to show users what is collected.
 */
export function buildEventPreview(): Record<string, unknown> {
  return {
    distinct_id: getStableMachineId(),
    cli_version: getCliVersion(),
    node_version: process.version.replace('v', ''),
    os: process.platform,
    arch: process.arch,
    installed_providers: detectProviders(),
    has_hook: detectHook(),
    total_sessions: '(queried from SQLite when DB is open)',
    sample_event: {
      event: 'cli_sync',
      properties: {
        duration_ms: 1234,
        sessions_synced: 5,
        sessions_by_provider: { 'claude-code': 4, cursor: 1 },
        errors: 0,
        source_filter: null,
        success: true,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Stable machine ID — does NOT rotate monthly.
 *
 * Format: SHA-256(hostname:username:code-insights).slice(0, 16)
 *
 * No PII: hostname and username are never transmitted, only their hash.
 * Deterministic: same machine always produces the same ID (survives reinstalls).
 */
export function getStableMachineId(): string {
  let username: string;
  try {
    username = os.userInfo().username;
  } catch {
    // os.userInfo() throws in Docker/CI when UID has no /etc/passwd entry
    username = `uid-${process.getuid?.() ?? 'unknown'}`;
  }

  const input = [os.hostname(), username, 'code-insights'].join(':');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Read CLI version from package.json.
 */
function getCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

/**
 * Detect which AI coding tool data directories exist on this machine.
 * Checks directory existence only — never reads file contents.
 */
function detectProviders(): string[] {
  const home = os.homedir();
  const detected: string[] = [];

  if (fs.existsSync(path.join(home, '.claude', 'projects'))) {
    detected.push('claude-code');
  }

  const cursorStoragePaths = [
    path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage'),
    path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage'),
  ];
  if (cursorStoragePaths.some((p) => fs.existsSync(p))) {
    detected.push('cursor');
  }

  if (fs.existsSync(path.join(home, '.codex', 'sessions'))) {
    detected.push('codex-cli');
  }

  if (fs.existsSync(path.join(home, '.copilot', 'session-state'))) {
    detected.push('copilot-cli');
  }

  return detected;
}

/**
 * Check if code-insights is registered as a Claude Code hook.
 */
function detectHook(): boolean {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return false;
    const content = fs.readFileSync(settingsPath, 'utf-8');
    return content.includes('code-insights');
  } catch {
    return false;
  }
}
