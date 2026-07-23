import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const originalDbPath = process.env.CODE_INSIGHTS_DB;
const tempDirs: string[] = [];

async function loadClient(dbPath: string) {
  process.env.CODE_INSIGHTS_DB = dbPath;
  vi.resetModules();
  return import('./client.js');
}

afterEach(() => {
  if (originalDbPath === undefined) {
    delete process.env.CODE_INSIGHTS_DB;
  } else {
    process.env.CODE_INSIGHTS_DB = originalDbPath;
  }
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('getDbIdentity', () => {
  it('combines the absolute path with a stable identity stored inside SQLite', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-insights-db-id-'));
    tempDirs.push(tempDir);
    const relativeDbPath = path.relative(process.cwd(), path.join(tempDir, 'data.db'));

    const firstClient = await loadClient(relativeDbPath);
    firstClient.getDb();
    const firstIdentity = firstClient.getDbIdentity();
    firstClient.closeDb();

    const reopenedClient = await loadClient(relativeDbPath);
    reopenedClient.getDb();
    const reopenedIdentity = reopenedClient.getDbIdentity();
    reopenedClient.closeDb();

    expect(firstIdentity).toBe(reopenedIdentity);
    expect(firstIdentity.startsWith(`${path.resolve(relativeDbPath)}#`)).toBe(true);
  });

  it('changes when a different SQLite database replaces the file at the same path', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-insights-db-replace-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'data.db');

    const firstClient = await loadClient(dbPath);
    firstClient.getDb();
    const firstIdentity = firstClient.getDbIdentity();
    firstClient.closeDb();

    fs.rmSync(dbPath);

    const replacementClient = await loadClient(dbPath);
    replacementClient.getDb();
    const replacementIdentity = replacementClient.getDbIdentity();
    replacementClient.closeDb();

    expect(replacementIdentity).not.toBe(firstIdentity);
    expect(replacementIdentity.split('#')[0]).toBe(firstIdentity.split('#')[0]);
  });

  it('detects restoration of an older backup from the same database lineage', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-insights-db-restore-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'data.db');
    const backupPath = path.join(tempDir, 'backup.db');

    const firstClient = await loadClient(dbPath);
    firstClient.getDb();
    firstClient.advanceDbSyncIdentity();
    const backedUpIdentity = firstClient.getDbIdentity();
    firstClient.closeDb();
    fs.copyFileSync(dbPath, backupPath);

    const laterClient = await loadClient(dbPath);
    laterClient.getDb();
    const currentIdentity = laterClient.advanceDbSyncIdentity();
    laterClient.closeDb();
    expect(currentIdentity).not.toBe(backedUpIdentity);

    fs.copyFileSync(backupPath, dbPath);

    const restoredClient = await loadClient(dbPath);
    restoredClient.getDb();
    const restoredIdentity = restoredClient.getDbIdentity();
    restoredClient.closeDb();

    expect(restoredIdentity).toBe(backedUpIdentity);
    expect(restoredIdentity).not.toBe(currentIdentity);
  });
});
