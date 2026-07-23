import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { loadSyncState, saveSyncState } from '../utils/config.js';
import { autoDetectOllama } from '../utils/ollama-detect.js';
import { trackEvent, identifyUser, captureError, classifyError } from '../utils/telemetry.js';
import {
  insertMessages,
  insertSessionWithProjectAndReturnIsNew,
  recalculateUsageStats,
  replaceSessionSnapshot,
} from '../db/write.js';
import { advanceDbSyncIdentity, getDb, getDbIdentity, getDbPath, getMigrationResult } from '../db/client.js';
import { sessionExists } from '../db/read.js';
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
  signature: string;
}

interface StableParseResult {
  session: Awaited<ReturnType<SessionProvider['parse']>>;
  snapshot: FileSnapshot;
}

const SNAPSHOT_PARSE_ATTEMPTS = 2;

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
  const successfullySyncedSessionIds = new Set<string>();
  const sessionsByProvider: Record<string, number> = {};
  for (const provider of providers) {
    const providerName = provider.getProviderName();
    const isCodexProvider = providerName === 'codex-cli';
    const isCopilotProvider = providerName === 'copilot-cli';
    const usesCompleteSnapshots = isCodexProvider || isCopilotProvider || providerName === 'cursor';
    const usesEffectiveCompleteSnapshot = usesCompleteSnapshots || !!options.force;
    const needsCodexIdMigration = isCodexProvider &&
      syncState.migrations?.codexScopedMessageIds !== true;
    const needsCopilotIdMigration = isCopilotProvider &&
      syncState.migrations?.copilotScopedMessageIds !== true;
    // A project-filtered discovery is not authoritative for all provider files.
    // Leave the one-time global migration for the next unfiltered sync.
    const runCodexIdMigration = needsCodexIdMigration && !options.project;
    const runCopilotIdMigration = needsCopilotIdMigration && !options.project;
    const runScopedIdMigration = runCodexIdMigration || runCopilotIdMigration;
    try {
      if (providers.length > 1) {
        log(chalk.cyan(`\n  Syncing ${providerName}...`));
      }

      // Discovery
      spinner.start(`Discovering ${providerName} sessions...`);
      const sessionFiles = await provider.discover({ projectFilter: options.project });
      spinner.stop();

      if (sessionFiles.length === 0) continue;

      // Scoped message-ID migrations must reparse unchanged historical
      // transcripts once so legacy global IDs cannot coexist with the new IDs.
      const filesToSync = filterFilesToSync(
        sessionFiles,
        syncState,
        !!options.force || runScopedIdMigration,
        provider,
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
          const parsed = usesEffectiveCompleteSnapshot
            ? await parseStableFile(provider, filePath)
            : { session: await provider.parse(filePath), snapshot: undefined };
          const { session } = parsed;
          if (!session) {
            const { realPath, sessionFragment } = splitVirtualPath(filePath);
            const previousFile = previousSyncState.files[realPath];
            const previousSessionId = providerName === 'cursor' && sessionFragment
              ? `cursor:${sessionFragment}`
              : previousFile?.sessionId;
            // null cannot currently distinguish an authoritative empty snapshot
            // from a provider that could not parse a previously valid session.
            // Preserve the stored data and retry instead of checkpointing data loss.
            if (
              usesEffectiveCompleteSnapshot
              &&
              previousSessionId
              && previousSessionId !== '__empty__'
              && sessionExists(previousSessionId)
            ) {
              totalErrorCount++;
              providerErrorCount++;
              spinner.warn(`Preserving previously synced session after an empty parse: ${fileName}`);
              continue;
            }
            // Track null-parse files so they aren't re-discovered on every sync run
            updateSyncState(
              syncState,
              filePath,
              '__empty__',
              parsed.snapshot,
              provider.getSourceFingerprint?.(filePath),
            );
            saveSyncState(syncState);
            continue;
          }

          // New trivial sessions are not useful enough to store. Existing
          // sessions still replace their snapshot so stale rows cannot survive
          // when a source shrinks from a longer conversation to ≤2 messages.
          const storedTrivialSession = session.messageCount <= 2
            && sessionExists(session.id);
          if (
            session.messageCount <= 2
            && (!usesEffectiveCompleteSnapshot || !storedTrivialSession)
          ) {
            updateSyncState(
              syncState,
              filePath,
              session.id,
              parsed.snapshot,
              provider.getSourceFingerprint?.(filePath),
            );
            saveSyncState(syncState);
            if (options.force && storedTrivialSession) {
              successfullySyncedSessionIds.add(session.id);
              providerSyncedCount++;
              providerUpdatedCount++;
              totalSyncedCount++;
              totalUpdatedExisting++;
            }
            continue;
          }

          // Complete-snapshot providers, and every forced snapshot replacement,
          // keep the session/project metadata and all messages in one
          // transaction with strict collision checks.
          let isNew: boolean;
          let snapshotChanged = false;
          if (usesEffectiveCompleteSnapshot) {
            ({ isNew, snapshotChanged } = replaceSessionSnapshot(session, !!options.force));
          } else {
            isNew = insertSessionWithProjectAndReturnIsNew(session, !!options.force);
            insertMessages(session, !!options.force);
          }
          const codexTranscriptChanged = isCodexProvider && parsed.snapshot !== undefined &&
            fileSnapshotChangedSinceSync(previousSyncState, filePath, parsed.snapshot);
          if (!isNew && (snapshotChanged || runScopedIdMigration || codexTranscriptChanged)) {
            // Legacy message-ID repair and later transcript edits can both
            // change analysis inputs without changing message_count. Preserve
            // visible insights, but force both analysis passes to recompute.
            invalidateAnalysisUsage(session.id);
          }

          // Update and persist sync state after each file
          // so progress survives crashes
          updateSyncState(
            syncState,
            filePath,
            session.id,
            parsed.snapshot,
            provider.getSourceFingerprint?.(filePath),
          );
          saveSyncState(syncState);
          successfullySyncedSessionIds.add(session.id);

          if (!isNew) {
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
      if (runCopilotIdMigration && providerErrorCount === 0) {
        syncState.migrations = {
          ...syncState.migrations,
          copilotScopedMessageIds: true,
        };
        saveSyncState(syncState);
        log(chalk.gray('  ✔ Migrated Copilot CLI messages to session-scoped IDs'));
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

  // A scoped or partially failed force sync is authoritative only for sessions
  // it actually processed. Never resurrect unrelated soft-deleted history.
  if (options.force && !options.dryRun && successfullySyncedSessionIds.size > 0) {
    const db = getDb();
    const resurrect = db.prepare(`
      UPDATE sessions
      SET deleted_at = NULL
      WHERE id = ? AND deleted_at IS NOT NULL
    `);
    for (const sessionId of successfullySyncedSessionIds) {
      resurrect.run(sessionId);
    }
  }

  // Always reconcile after a writable run. A previous process may have
  // checkpointed its files and exited before reaching this aggregate update;
  // the next otherwise-up-to-date run must still self-heal usage_stats.
  if (!options.dryRun) {
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

  if (session.messageCount <= 2) return;

  insertSessionWithProjectAndReturnIsNew(session, false);
  insertMessages(session);
}

/**
 * Filter files to only those that need syncing
 */
function filterFilesToSync(
  files: string[],
  syncState: SyncState,
  force: boolean | undefined,
  provider: SessionProvider,
): string[] {
  if (force) return files;

  return files.filter((filePath) => {
    const { realPath, sessionFragment } = splitVirtualPath(filePath);
    let snapshot: FileSnapshot;
    try {
      snapshot = getFileSnapshot(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`[sync] skipping disappeared file: ${realPath}`);
        return false;
      }
      throw err;
    }
    const fileState = syncState.files[realPath];

    // If file was never synced, sync it
    if (!fileState) return true;

    const changed = fileState.fileSignature !== undefined
      ? fileState.fileSignature !== snapshot.signature
      : fileState.lastModified !== snapshot.lastModified
        || (fileState.fileSize !== undefined && fileState.fileSize !== snapshot.size);

    if (sessionFragment) {
      // Virtual path (multi-session DB).
      // If the DB file changed, re-sync all sessions from it.
      if (changed) return true;

      // Otherwise only sync sessions we haven't seen yet.
      if (fileState.syncedSessionIds) {
        if (!fileState.syncedSessionIds.includes(sessionFragment)) return true;
        if (provider.getSourceFingerprint) {
          const currentFingerprint = provider.getSourceFingerprint(filePath);
          const previousFingerprint = fileState.virtualSourceFingerprints?.[sessionFragment];
          // A null fingerprint means this virtual session has no auxiliary
          // provider-owned input. Legacy checkpoints therefore remain valid,
          // while a prior non-null fingerprint disappearing still invalidates.
          if (currentFingerprint === null && previousFingerprint === undefined) {
            return false;
          }
          return previousFingerprint !== currentFingerprint;
        }
        return false;
      }

      // Virtual path but no syncedSessionIds tracked yet — needs sync
      return true;
    }

    // For regular files, check if modified since last sync
    return changed;
  });
}

function getFileSnapshot(filePath: string): FileSnapshot {
  const { realPath } = splitVirtualPath(filePath);
  const paths = [realPath, `${realPath}-wal`];
  const parts = paths.map(candidate => {
    try {
      const stat = fs.statSync(candidate);
      return {
        path: candidate === realPath ? 'main' : 'wal',
        lastModified: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && candidate !== realPath) {
        return null;
      }
      throw error;
    }
  }).filter((part): part is {
    path: string;
    lastModified: string;
    mtimeMs: number;
    size: number;
  } => part !== null);
  const mtimeMs = Math.max(...parts.map(part => part.mtimeMs));
  const size = parts.reduce((total, part) => total + part.size, 0);
  const latest = parts.reduce((current, part) => (
    part.mtimeMs > current.mtimeMs ? part : current
  ));
  return {
    lastModified: latest.lastModified,
    mtimeMs,
    size,
    signature: JSON.stringify(parts),
  };
}

function snapshotsMatch(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.signature === right.signature;
}

function fileSnapshotChangedSinceSync(
  state: SyncState,
  filePath: string,
  snapshot: FileSnapshot,
): boolean {
  const { realPath } = splitVirtualPath(filePath);
  const previous = state.files[realPath];
  if (!previous) return false;

  return previous.fileSignature !== undefined
    ? previous.fileSignature !== snapshot.signature
    : previous.lastModified !== snapshot.lastModified
      || (previous.fileSize !== undefined && previous.fileSize !== snapshot.size);
}

/**
 * Parse a provider session from one stable filesystem snapshot.
 * An actively changing source is retried once. If it changes again, callers
 * leave both SQLite and sync-state untouched so the next sync can try again.
 */
async function parseStableFile(
  provider: SessionProvider,
  filePath: string,
): Promise<StableParseResult> {
  for (let attempt = 1; attempt <= SNAPSHOT_PARSE_ATTEMPTS; attempt++) {
    const before = getFileSnapshot(filePath);
    const session = await provider.parse(filePath);
    const after = getFileSnapshot(filePath);

    if (snapshotsMatch(before, after)) {
      return { session, snapshot: after };
    }
  }

  throw new Error(`Session source changed while parsing: ${filePath}`);
}

/**
 * Update sync state for a file
 */
function updateSyncState(
  state: SyncState,
  filePath: string,
  sessionId: string,
  parsedSnapshot?: FileSnapshot,
  sourceFingerprint?: string | null,
): void {
  const { realPath, sessionFragment } = splitVirtualPath(filePath);
  const currentSnapshot = parsedSnapshot ?? getFileSnapshot(filePath);
  const {
    lastModified,
    size: fileSize,
    signature: fileSignature,
  } = currentSnapshot;

  if (sessionFragment) {
    // Virtual path: track the session fragment in syncedSessionIds
    const existing = state.files[realPath];
    const sameSnapshot = existing !== undefined && (
      existing.fileSignature !== undefined
        ? existing.fileSignature === fileSignature
        : existing.lastModified === lastModified
          && (existing.fileSize === undefined || existing.fileSize === fileSize)
    );
    // A changed multi-session DB starts a new reconciliation generation.
    // Retaining the old IDs would hide fragments not reached before a crash.
    const syncedIds = sameSnapshot ? [...(existing.syncedSessionIds || [])] : [];
    const virtualSourceFingerprints = sameSnapshot
      ? { ...(existing.virtualSourceFingerprints || {}) }
      : {};
    if (!syncedIds.includes(sessionFragment)) {
      syncedIds.push(sessionFragment);
    }
    if (sourceFingerprint === null) {
      delete virtualSourceFingerprints[sessionFragment];
    } else if (sourceFingerprint !== undefined) {
      virtualSourceFingerprints[sessionFragment] = sourceFingerprint;
    }
    state.files[realPath] = {
      lastModified,
      fileSize,
      fileSignature,
      lastSyncedLine: 0,
      sessionId,
      syncedSessionIds: syncedIds,
      ...(Object.keys(virtualSourceFingerprints).length > 0
        ? { virtualSourceFingerprints }
        : {}),
    };
  } else {
    // Regular file path
    state.files[realPath] = {
      lastModified,
      fileSize,
      fileSignature,
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
