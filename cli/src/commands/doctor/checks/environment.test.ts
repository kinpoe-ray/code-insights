import { afterEach, describe, expect, it } from 'vitest';
import { environmentChecks } from './environment.js';

const actualNodeVersion = process.versions.node;

function setNodeVersion(version: string): void {
  Object.defineProperty(process.versions, 'node', {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

async function runNodeVersionCheck(version: string) {
  setNodeVersion(version);
  const check = environmentChecks().find(
    (candidate) => candidate.id === 'env.node_version',
  );
  if (!check) throw new Error('Node.js version check is missing');
  return check.run();
}

describe('doctor Node.js support policy', () => {
  afterEach(() => {
    setNodeVersion(actualNodeVersion);
  });

  it.each(['20.0.0', '20.19.4', '22.0.0', '22.17.1', '24.0.0', '25.1.0'])(
    'accepts supported Node.js %s',
    async (version) => {
      await expect(runNodeVersionCheck(version)).resolves.toMatchObject({
        status: 'pass',
        detail: `v${version}`,
      });
    },
  );

  it.each(['18.20.8', '19.9.0', '21.7.3', '23.11.1'])(
    'rejects unsupported Node.js %s',
    async (version) => {
      await expect(runNodeVersionCheck(version)).resolves.toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('20.x, 22.x, or >=24'),
        hint: expect.stringContaining('Node.js 20, 22, or 24+'),
      });
    },
  );
});
