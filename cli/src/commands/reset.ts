import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, unlinkSync } from 'fs';
import { getDb, getDbPath } from '../db/client.js';
import { getSyncStatePath } from '../utils/config.js';
import { trackEvent, captureError, classifyError } from '../utils/telemetry.js';

export const resetCommand = new Command('reset')
  .description('Delete all synced data from the local SQLite database and reset sync state')
  .option('--confirm', 'Skip confirmation prompt')
  .action(async (options) => {
    console.log(chalk.red.bold('\n  WARNING: This will permanently delete ALL synced data from your local database!'));
    console.log(chalk.yellow('  Tables to be cleared: projects, sessions, messages, insights, session_facets, reflect_snapshots, analysis_usage, analysis_queue, analysis_campaigns, usage_stats\n'));

    if (!options.confirm) {
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.cyan('Type "DELETE" to confirm: '), resolve);
      });
      rl.close();

      if (answer !== 'DELETE') {
        console.log(chalk.gray('\nAborted. No data was deleted.'));
        process.exit(0);
      }
    }

    console.log('');

    // Delete all user data in a single transaction.
    // If any DELETE fails, the transaction rolls back atomically and we do NOT
    // proceed to delete the sync state file (which would leave them out of sync).
    const dbSpinner = ora('Clearing database...').start();
    try {
      const db = getDb();
      const clearAll = db.transaction(() => {
        // Delete in dependency order (FK constraints)
        db.prepare('DELETE FROM analysis_campaign_snapshots').run();
        db.prepare('DELETE FROM analysis_campaign_items').run();
        db.prepare('DELETE FROM analysis_campaigns').run();
        db.prepare('DELETE FROM analysis_queue').run();
        db.prepare('DELETE FROM analysis_usage').run();
        db.prepare('DELETE FROM insights').run();
        db.prepare('DELETE FROM session_facets').run();
        db.prepare('DELETE FROM reflect_snapshots').run();
        db.prepare('DELETE FROM messages').run();
        db.prepare('DELETE FROM sessions').run();
        db.prepare('DELETE FROM projects').run();
        db.prepare('DELETE FROM usage_stats').run();

        // Rotate the generation in the same transaction as the deletes. If the
        // sync-state file cannot be removed later, its old checkpoint no longer
        // matches this database and the next sync must rebuild.
        const rotated = db.prepare(`
          UPDATE code_insights_metadata
          SET value = lower(hex(randomblob(16)))
          WHERE key = 'sync_generation'
        `).run();
        if (rotated.changes !== 1) {
          throw new Error('Could not rotate database sync identity');
        }
      });
      clearAll();
      dbSpinner.succeed(`Database cleared (${getDbPath()})`);
    } catch (error) {
      dbSpinner.fail(`Failed to clear database: ${error instanceof Error ? error.message : error}`);
      console.error(chalk.red('\nAborted. Sync state was NOT deleted to avoid inconsistency.'));
      console.error(chalk.dim('Run `code-insights doctor` if the problem persists.'));
      const { error_type, error_message } = classifyError(error);
      trackEvent('cli_reset', { success: false, error_type, error_message });
      captureError(error, { command: 'reset', error_type });
      process.exit(1);
    }

    // Delete local sync state — only reached if DB clear succeeded
    const syncStatePath = getSyncStatePath();
    const syncSpinner = ora('Removing local sync state...').start();
    try {
      if (existsSync(syncStatePath)) {
        unlinkSync(syncStatePath);
        syncSpinner.succeed('Removed local sync state');
      } else {
        syncSpinner.info('No local sync state file found');
      }
    } catch (error) {
      syncSpinner.fail(`Failed to remove sync state: ${error}`);
      console.error(chalk.red('\nReset incomplete: the local sync state file could not be removed.'));
      console.error(chalk.dim(
        'The database was cleared and its sync identity changed, so the next sync will rebuild instead of resuming the old checkpoint.',
      ));
      process.exitCode = 1;
      try {
        const { error_type, error_message } = classifyError(error);
        trackEvent('cli_reset', { success: false, error_type, error_message });
        captureError(error, { command: 'reset', error_type });
      } catch {
        // Telemetry must never turn this explicit failure into a success exit.
      }
      return;
    }

    // Report the completed reset without letting telemetry affect the command.
    try {
      trackEvent('cli_reset', { success: true });
    } catch {
      // non-fatal
    }

    console.log(chalk.green('\n  Reset complete. Run `code-insights sync` to re-sync all sessions.\n'));
    process.exit(0);
  });
