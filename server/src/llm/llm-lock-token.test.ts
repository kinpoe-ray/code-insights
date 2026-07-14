import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireGlobal: vi.fn(),
  isTokenOwner: vi.fn(),
}));

vi.mock('@code-insights/cli/analysis/llm-lock', () => ({
  LLM_LOCK_TOKEN_HEADER: 'x-code-insights-lock-token',
  acquireLlmLock: (...args: unknown[]) => mocks.acquireGlobal(...args),
  isLlmLockTokenOwner: (...args: unknown[]) => mocks.isTokenOwner(...args),
}));

const { acquireServerLlmLock } = await import('./llm-lock.js');

function requestContext(token?: string): Context {
  return {
    req: {
      header: (name: string) => name.toLowerCase() === 'x-code-insights-lock-token' ? token : undefined,
    },
  } as unknown as Context;
}

describe('server LLM lock capability', () => {
  beforeEach(() => {
    mocks.acquireGlobal.mockReset();
    mocks.acquireGlobal.mockReturnValue(null);
    mocks.isTokenOwner.mockReset();
    mocks.isTokenOwner.mockImplementation((token: string) => token === 'valid-owner-token');
  });

  it('allows the owning request token while preserving the in-process gate', () => {
    const context = requestContext('valid-owner-token');

    const first = acquireServerLlmLock(context);
    expect(first).not.toBeNull();
    expect(mocks.isTokenOwner).toHaveBeenCalledWith('valid-owner-token');
    expect(mocks.acquireGlobal).not.toHaveBeenCalled();

    try {
      expect(acquireServerLlmLock(context)).toBeNull();
    } finally {
      first?.release();
    }

    const afterRelease = acquireServerLlmLock(context);
    expect(afterRelease).not.toBeNull();
    afterRelease?.release();
  });

  it('does not bypass a busy global lock without the owning token', () => {
    expect(acquireServerLlmLock(requestContext())).toBeNull();
    expect(acquireServerLlmLock(requestContext('wrong-token'))).toBeNull();
    expect(mocks.acquireGlobal).toHaveBeenCalledTimes(2);
  });
});
