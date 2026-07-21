import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { ensureConfigDir, getConfigDir } from '../utils/config.js';

const PAUSE_MARKER_NAME = 'maintenance.paused';

function getPauseMarkerPath(): string {
  return join(getConfigDir(), PAUSE_MARKER_NAME);
}

export function isMaintenancePaused(): boolean {
  return existsSync(getPauseMarkerPath());
}

function pauseMaintenance(): void {
  ensureConfigDir();
  const markerPath = getPauseMarkerPath();

  try {
    writeFileSync(markerPath, '', { flag: 'wx', mode: 0o600 });
    console.log('Maintenance paused.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    console.log('Maintenance is already paused.');
  }
}

function resumeMaintenance(): void {
  try {
    unlinkSync(getPauseMarkerPath());
    console.log('Maintenance resumed.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.log('Maintenance is already running.');
  }
}

export function buildMaintenanceCommand(): Command {
  const command = new Command('maintenance')
    .description('Control automatic maintenance');

  command
    .command('pause')
    .description('Pause automatic sync and analysis')
    .action(pauseMaintenance);

  command
    .command('status')
    .description('Print running or paused for scripts')
    .action(() => {
      const paused = isMaintenancePaused();
      process.stdout.write(`${paused ? 'paused' : 'running'}\n`);
      process.exitCode = paused ? 3 : 0;
    });

  command
    .command('resume')
    .description('Resume automatic sync and analysis')
    .action(resumeMaintenance);

  return command;
}
