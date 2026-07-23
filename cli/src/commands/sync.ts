import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { loadSyncState, saveSyncState } from '../utils/config.js';
import { autoDetectOllama } from '../utils/ollama-detect.js';
import { trackEvent, identifyUser, captureError, classifyError } from '../utils/telemetry.js';
import { insertSessionWithProjectAndReturnIsNew, insertMessages, recalculateUsageStats } from '../db/write.js';
import { advanceDbSyncIdentity, getDb, getDbIdentity, getDbPath, getMigrationResult } from '../db/client.js';
import { getAllProviders, getProvider } from '../providers/registry.js';
import { setProviderVerbose } from '../providers/context.js';
import { invalidateAnalysisUsage } from '../analysis/analysis-usage-db.js';
import type { SessionProvider } from '../providers/types.js';
import type { SyncState } from '../types.js';
import { splitVirtualPath } from '../utils/paths.js';

interface SyncOptions {
  force?: boolean;
  project?: string;
  dryRun?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  regenerateTitles?: boolean;
  source?: string;
}

export interface SyncResult {
  syncedCount: number;
  messageCount: number;
  errorCount: number;
  updatedExistingCount: number;
  sessionsByProvider: Record<string, number>;
}

interface FileSnapshot {
  lastModified: string;
  mtimeMs: number;
  size: number;
}

interface StableParseResult {
  session: Awaited<ReturnType<SessionProvider['parse']>>;
  snapshot: FileSnapshot;
}

const CODEX_PARSE_ATTEMPTS = 2;

/**
 * Core sync logic — reusable from stats commands and other callers.
 *
 * Parses sessions from all configured providers and writes to local SQLite.
 * Throws on fatal errors (unknown provider) instead of calling process.exit().
 * Returns a SyncResult summary.
 */
export async function runSync(options: SyncOptions = {}): Promise<SyncResult> {
  const log = options.quiet ? () => {} : console.log.bind(console);
  const noopSpinner = {
    start: function() { return this; },
    succeed: function() { return this; },
    fail: function() { return this; },
    warn: function() { return this; },
    info: function() { return this; },
    stop: function() { return this; },
  };
  const createSpinner = options.quiet
    ? () => noopSpinner
    : ora;

  log(chalk.cyan('\n  Code Insights Sync\n'));

  const spinner = createSpinner('Initializing database...');
  let databaseIdentity: string | undefined;
  let v6JustApplied = false;

  // A dry run is a read-only filesystem plan. In particular, do not open
  // SQLite: getDb() would create the file and run migrations as a side effect.
  if (!options.dryRun) {
    spinner.start();
    try {
      getDb();
      databaseIdentity = getDbIdentity();
      spinner.succeed('Database ready');
    } catch (error) {
      spinner.fail('Failed to initialize database');
      throw new Error(`Database error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Auto-detect Ollama if no LLM is configured (silent if not running).
    // This may persist config, so it is intentionally excluded from dry runs.
    if (!options.quiet) {
      await autoDetectOllama();
    }

    // Check if V6 migration was just applied — triggers auto force-sync for interactive sessions
    const migrationResult = getMigrationResult();
    v6JustApplied = migrationResult?.v6Applied === true;
  }

  if (v6JustApplied && options.quiet) {
    // Hook-triggered sync: defer re-parse to avoid adding 30-60s to a sub-second operation
    process.stderr.write("Message counts updated in v6. Run 'code-insights sync --force' to recalculate.\n");
  }

  // Auto force-sync on V6 migration (interactive only, not quiet/hook mode)
  if (v6JustApplied && !options.quiet && !options.force && !options.dryRun) {
    log(chalk.cyan('\n  V6 migration: recalculating message counts across all sessions...'));
    log(chalk.dim('  Fixed: user messages were previously overcounted by including tool results and system messages'));
    // Trigger force re-parse by treating this as a force sync for state reset
    options = { ...options, force: true };
  }

  // Dry-run banner
  if (options.dryRun) {
    log(chalk.yellow('\n  Dry run -- no changes will be made'));
  }

  // Set verbose flag for providers (e.g., gates Cursor diagnostic warnings)
  setProviderVerbose(!!options.verbose);

  // Get providers to sync
  let providers: SessionProvider[];
  if (options.source) {
    try {
      providers = [getProvider(options.source)];
    } catch {
      throw new Error(`Unknown source: ${options.source}. Available: ${getAllProviders().map(p => p.getProviderName()).join(', ')}`);
    }
  } else {
    providers = getAllProviders();
  }

  // Load sync state
  // When --force is used with --source, only clear the targeted provider's entries
  // instead of nuking the entire sync state.
  const loadedSyncState = loadSyncState();
  const previousSyncState = structuredClone(loadedSyncState);
  // Force/identity reconciliation intentionally mutates state in memory. A dry
  // run operates on a clone so its "no changes" contract includes checkpoints
  // and one-time migration flags.
  const syncState = options.dryRun
    ? structuredClone(loadedSyncState)
    : loadedSyncState;
  const databaseChanged = options.dryRun
    ? !fs.existsSync(getDbPath()) || !syncState.databaseIdentity
    : syncState.databaseIdentity !== databaseIdentity;
  if (databaseChanged) {
    // File mtimes and one-time migrations describe one exact SQLite database.
    // Conservatively re-sync once when upgrading legacy state or when the DB
    // path/file changes, so an empty/restored database cannot inherit skips.
    syncState.lastSync = '';
    syncState.files = {};
    syncState.migrations = {};
    syncState.databaseIdentity = databaseIdentity;
  }
  if (options.force) {
    if (options.source) {
      // Targeted force: remove only entries belonging to the specified provider's files
      const targetProviderPaths = new Set<string>();
      for (const provider of providers) {
        const discovered = await provider.discover({ projectFilter: options.project });
        for (const p of discovered) {
          const { realPath } = splitVirtualPath(p);
          targetProviderPaths.add(realPath);
        }
      }
      for (const key of Object.keys(syncState.files)) {
        if (targetProviderPaths.has(key)) {
          delete syncState.files[key];
        }
      }
    } else {
      // Full force: reset everything
      syncState.files = {};
    }
  }

  let totalSyncedCount = 0;
  let totalMessageCount = 0;
  let totalErrorCount = 0;
  let totalUpdatedExisting = 0;
  const sessionsByProvider: Record<string, number> = {};
  for (const provider of providers) {
    const providerName = provider.getProviderName();
    const isCodexProvider = providerName === 'codex-cli';
    const needsCodexIdMigration = isCodexProvider &&
      syncState.migrations?.codexScopedMessageIds !== true;
    // A project-filtered discovery is not authoritative for all Codex files.
    // Leave the one-time global migration for the next unfiltered sync.
    const runCodexIdMigration = needsCodexIdMigration && !options.project;
    try {
      if (providers.length > 1) {
        log(chalk.cyan(`\n  Syncing ${providerName}...`));
      }

      // Discovery
      spinner.start(`Discovering ${providerName} sessions...`);
      const sessionFiles = await provider.discover({ projectFilter: options.project });
      spinner.stop();

      if (sessionFiles.length === 0) continue;

      // The scoped Codex message-ID migration must reparse unchanged historical
      // transcripts once so legacy global IDs cannot coexist with the new IDs.
      const filesToSync = filterFilesToSync(
        sessionFiles,
        syncState,
        !!options.force || runCodexIdMigration,
      );

      if (filesToSync.length === 0) {
        log(chalk.gray(`  ✔ Up to date (${sessionFiles.length} sessions)`));
        continue;
      }

      if (options.dryRun) {
        for (const file of filesToSync) {
          log(chalk.gray(`  Would sync: ${path.basename(file)}`));
        }
        continue;
      }

      // Process files — accumulate per-provider counts, show one summary line after
      let providerSyncedCount = 0;
      let providerUpdatedCount = 0;
      let providerMessageCount = 0;
      let providerErrorCount = 0;

      for (const filePath of filesToSync) {
        const fileName = path.basename(filePath);
        spinner.start(`Processing ${fileName}...`);

        try {
          // Parse session
          const parsed = isCodexProvider
            ? await parseStableFile(provider, filePath)
            : { session: await provider.parse(filePath), snapshot: undefined };
          const { session } = parsed;
          if (!session) {
            // Track null-parse files so they aren't re-discovered on every sync run
            updateSyncState(syncState, filePath, '__empty__', parsed.snapshot);
            saveSyncState(syncState);
            continue;
          }

          // Skip trivial sessions (≤2 messages) — likely abandoned prompts with no content
          if (session.messageCount <= 2) {
            updateSyncState(syncState, filePath, session.id, parsed.snapshot);
            saveSyncState(syncState);
            continue;
          }

          // Write session and messages to SQLite
          const isNew = insertSessionWithProjectAndReturnIsNew(session, !!options.force);
          // Codex providers parse complete transcript snapshots. Always replace
          // their message set so index-based IDs cannot leave stale rows after
          // an insertion or after upgrading from the legacy global ID scheme.
          insertMessages(session, !!options.force || isCodexProvider);
          const codexTranscriptChanged = isCodexProvider && parsed.snapshot !== undefined &&
            fileSnapshotChangedSinceSync(previousSyncState, filePath, parsed.snapshot);
          if (!isNew && (runCodexIdMigration || codexTranscriptChanged)) {
            // Legacy message-ID repair and later transcript edits can both
            // change analysis inputs without changing message_count. Preserve
            // visible insights, but force both analysis passes to recompute.
            invalidateAnalysisUsage(session.id);
          }

          // Update and persist sync state after each file
          // so progress survives crashes
          updateSyncState(syncState, filePath, session.id, parsed.snapshot);
          saveSyncState(syncState);

          if (!isNew && !options.force) {
            providerUpdatedCount++;
            totalUpdatedExisting++;
          }

          providerSyncedCount++;
          providerMessageCount += session.messages.length;
          totalSyncedCount++;
          totalMessageCount += session.messages.length;
        } catch (error) {
          totalErrorCount++;
          providerErrorCount++;
          spinner.fail(`Failed to sync ${fileName}`);
          if (!options.quiet) {
            console.error(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
          }
        }
      }

      if (runCodexIdMigration && providerErrorCount === 0) {
        syncState.migrations = {
          ...syncState.migrations,
          codexScopedMessageIds: true,
        };
        saveSyncState(syncState);
        log(chalk.gray('  ✔ Migrated Codex messages to session-scoped IDs'));
      }

      sessionsByProvider[providerName] = providerSyncedCount;

      // One summary line per provider instead of per-file noise
      spinner.stop();
      if (providerSyncedCount > 0) {
        const providerNewCount = providerSyncedCount - providerUpdatedCount;
        const parts: string[] = [];
        if (providerNewCount > 0) parts.push(`${providerNewCount} new`);
        if (providerUpdatedCount > 0) parts.push(`${providerUpdatedCount} updated`);
        if (parts.length === 0) parts.push('0 synced');
        const syncedPart = `${parts.join(', ')}${providerMessageCount > 0 ? ` (${providerMessageCount.toLocaleString()} messages)` : ''}`;
        log(chalk.gray(`  ✔ Synced ${syncedPart}`));
      }
    } catch (error) {
      totalErrorCount++;
      spinner.fail(`Failed to sync ${providerName}`);
      if (!options.quiet) {
        console.error(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    }
  }

  // Resurrect soft-deleted sessions on --force so users get a clean slate
  if (options.force && !options.dryRun) {
    const db = getDb();
    db.prepare('UPDATE sessions SET deleted_at = NULL WHERE deleted_at IS NOT NULL').run();
  }

  // Reconcile usage stats after force sync (skip if nothing changed)
  const shouldRecalculateUsageStats = options.force
    ? (totalSyncedCount > 0 || totalErrorCount > 0)
    : totalUpdatedExisting > 0;

  if (!options.dryRun && shouldRecalculateUsageStats) {
    spinner.start('Recalculating usage stats...');
    try {
      recalculateUsageStats();
      spinner.stop();
    } catch (error) {
      spinner.warn('Could not reconcile usage stats');
      if (!options.quiet) {
        console.error(chalk.red(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    }
  }

  // After V6 auto force-sync: all re-synced sessions have updated message counts.
  // Any existing insights were generated from the old (inflated) counts — show advisory.
  if (v6JustApplied && !options.quiet && totalSyncedCount > 0) {
    log(chalk.dim(`\n  i ${totalSyncedCount} sessions have updated message counts. Existing insights may reflect old data.`));
    log(chalk.dim(`    Run 'code-insights reflect backfill' to regenerate (uses LLM API credits).`));

    trackEvent('migration_v6_resync', {
      sessions_recalculated: totalSyncedCount,
      insight_count: totalSyncedCount,
    });
  }

  // Save sync state
  if (!options.dryRun) {
    syncState.databaseIdentity = advanceDbSyncIdentity();
    syncState.lastSync = new Date().toISOString();
    saveSyncState(syncState);
  }

  return {
    syncedCount: totalSyncedCount,
    messageCount: totalMessageCount,
    errorCount: totalErrorCount,
    updatedExistingCount: totalUpdatedExisting,
    sessionsByProvider,
  };
}

/**
 * Sync AI coding sessions to local SQLite database
 */
export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  const log = options.quiet ? () => {} : console.log.bind(console);
  const startTime = Date.now();

  try {
    const result = await runSync(options);
    const duration_ms = Date.now() - startTime;

    // Identify user only after a writable sync has opened the DB. A dry run
    // must remain safe even when the database does not exist yet.
    if (!options.dryRun) {
      void identifyUser();
    }

    // Summary (only if not quiet)
    if (result.syncedCount === 0 && result.errorCount === 0) {
      log(chalk.green('\n  Already up to date!'));
      if (!options.dryRun) {
        trackEvent('cli_sync', {
          duration_ms,
          sessions_synced: 0,
          sessions_by_provider: result.sessionsByProvider,
          errors: 0,
          source_filter: options.source ?? null,
          success: true,
        });
      }
      return;
    }
    log(chalk.cyan('\n  Sync Summary'));
    const newCount = Math.max(result.syncedCount - result.updatedExistingCount, 0);
    log(chalk.white(`  Sessions new: ${newCount}`));
    if (result.updatedExistingCount > 0) {
      log(chalk.white(`  Sessions updated: ${result.updatedExistingCount}`));
    }
    log(chalk.white(`  Messages synced: ${result.messageCount}`));
    if (result.errorCount > 0) {
      log(chalk.red(`  Errors: ${result.errorCount}`));
    }
    const succeeded = result.errorCount === 0;
    log(succeeded
      ? chalk.green('\n  Sync complete!')
      : chalk.yellow('\n  Sync completed with errors.'));
    if (!options.dryRun) {
      trackEvent('cli_sync', {
        duration_ms,
        sessions_synced: result.syncedCount,
        sessions_by_provider: result.sessionsByProvider,
        errors: result.errorCount,
        source_filter: options.source ?? null,
        success: succeeded,
      });
    }
    if (!succeeded) {
      // Successfully imported files stay checkpointed, but callers must be
      // able to detect that at least one transcript was not synchronized.
      process.exitCode = 1;
    }
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const { error_type, error_message } = classifyError(error);
    if (!options.dryRun) {
      trackEvent('cli_sync', {
        duration_ms,
        sessions_synced: 0,
        sessions_by_provider: {},
        errors: 1,
        source_filter: options.source ?? null,
        success: false,
        error_type,
        error_message,
      });
      captureError(error, { command: 'sync', error_type, source_filter: options.source ?? null });
    }
    if (!options.quiet) {
      console.error(chalk.red(error instanceof Error ? error.message : 'Sync failed'));
    }
    process.exit(1);
  }
}


/**
 * Sync a single session file to SQLite.
 * Used by the insights --hook path to guarantee fresh data before analysis.
 * Much faster than full sync (no directory scanning, no other providers).
 */
export async function syncSingleFile(options: {
  filePath: string;
  sourceTool?: string;
  quiet?: boolean;
}): Promise<void> {
  const provider = getProvider(options.sourceTool ?? 'claude-code');
  const session = await provider.parse(options.filePath);
  if (!session) return;

  // Data quality invariant: skip trivial sessions (matches runSync filter at line ~194)
  if (session.messageCount <= 2) return;

  insertSessionWithProjectAndReturnIsNew(session, false);
  insertMessages(session);
}

/**
 * Filter files to only those that need syncing
 */
function filterFilesToSync(files: string[], syncState: SyncState, force?: boolean): string[] {
  if (force) return files;

  return files.filter((filePath) => {
    const { realPath, sessionFragment } = splitVirtualPath(filePath);
    let stat: ReturnType<typeof fs.statSync>;
    try {
      stat = fs.statSync(realPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`[sync] skipping disappeared file: ${realPath}`);
        return false;
      }
      throw err;
    }
    const lastModified = stat.mtime.toISOString();
    const fileState = syncState.files[realPath];

    // If file was never synced, sync it
    if (!fileState) return true;

    if (sessionFragment) {
      // Virtual path (multi-session DB).
      // If the DB file changed, re-sync all sessions from it.
      if (fileState.lastModified !== lastModified ||
          (fileState.fileSize !== undefined && fileState.fileSize !== stat.size)) return true;

      // Otherwise only sync sessions we haven't seen yet.
      if (fileState.syncedSessionIds) {
        return !fileState.syncedSessionIds.includes(sessionFragment);
      }

      // Virtual path but no syncedSessionIds tracked yet — needs sync
      return true;
    }

    // For regular files, check if modified since last sync
    return fileState.lastModified !== lastModified ||
      (fileState.fileSize !== undefined && fileState.fileSize !== stat.size);
  });
}

function getFileSnapshot(filePath: string): FileSnapshot {
  const { realPath } = splitVirtualPath(filePath);
  const stat = fs.statSync(realPath);
  return {
    lastModified: stat.mtime.toISOString(),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function snapshotsMatch(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function fileSnapshotChangedSinceSync(
  state: SyncState,
  filePath: string,
  snapshot: FileSnapshot,
): boolean {
  const { realPath } = splitVirtualPath(filePath);
  const previous = state.files[realPath];
  if (!previous) return false;

  return previous.lastModified !== snapshot.lastModified ||
    (previous.fileSize !== undefined && previous.fileSize !== snapshot.size);
}

/**
 * Parse an append-only Codex rollout from one stable filesystem snapshot.
 * A growing active transcript is retried once. If it changes again, callers
 * leave both SQLite and sync-state untouched so the next sync can try again.
 */
async function parseStableFile(
  provider: SessionProvider,
  filePath: string,
): Promise<StableParseResult> {
  for (let attempt = 1; attempt <= CODEX_PARSE_ATTEMPTS; attempt++) {
    const before = getFileSnapshot(filePath);
    const session = await provider.parse(filePath);
    const after = getFileSnapshot(filePath);

    if (snapshotsMatch(before, after)) {
      return { session, snapshot: after };
    }
  }

  throw new Error(`Codex transcript changed while parsing: ${filePath}`);
}

/**
 * Update sync state for a file
 */
function updateSyncState(
  state: SyncState,
  filePath: string,
  sessionId: string,
  parsedSnapshot?: FileSnapshot,
): void {
  const { realPath, sessionFragment } = splitVirtualPath(filePath);
  const currentSnapshot = parsedSnapshot ?? getFileSnapshot(filePath);
  const { lastModified, size: fileSize } = currentSnapshot;

  if (sessionFragment) {
    // Virtual path: track the session fragment in syncedSessionIds
    const existing = state.files[realPath];
    const syncedIds = existing?.syncedSessionIds || [];
    if (!syncedIds.includes(sessionFragment)) {
      syncedIds.push(sessionFragment);
    }
    state.files[realPath] = {
      lastModified,
      fileSize,
      lastSyncedLine: 0,
      sessionId,
      syncedSessionIds: syncedIds,
    };
  } else {
    // Regular file path
    state.files[realPath] = {
      lastModified,
      fileSize,
      lastSyncedLine: 0,
      sessionId,
    };
  }
}

interface TrivialSession {
  id: string;
  title: string | null;
  project_name: string;
  message_count: number;
}

/**
 * Return sessions with ≤2 messages that are not yet soft-deleted.
 * Used to preview what `sync prune` will affect before asking for confirmation.
 */
export function getTrivialSessions(): TrivialSession[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, COALESCE(custom_title, generated_title) as title, project_name, message_count
    FROM sessions
    WHERE message_count <= 2 AND deleted_at IS NULL
    ORDER BY started_at DESC
  `).all() as TrivialSession[];
}

/**
 * Soft-delete sessions with ≤2 messages — likely abandoned prompts with no useful content.
 * Unlike --force sync which resurrects deleted sessions, prune is a deliberate cleanup action.
 * Accepts the session IDs to delete so the caller can preview before executing.
 */
export function pruneTrivialSessions(ids: string[]): { deleted: number } {
  if (ids.length === 0) return { deleted: 0 };
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const result = db.prepare(`
    UPDATE sessions
    SET deleted_at = datetime('now')
    WHERE id IN (${placeholders}) AND deleted_at IS NULL
  `).run(...ids);
  return { deleted: result.changes };
}
