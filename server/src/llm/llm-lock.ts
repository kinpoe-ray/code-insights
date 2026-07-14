import {
  acquireLlmLock,
  isLlmLockTokenOwner,
  LLM_LOCK_TOKEN_HEADER,
  type LlmLockHandle,
} from '@code-insights/cli/analysis/llm-lock';
import type { Context } from 'hono';

export const LLM_BUSY_CODE = 'LLM_BUSY' as const;
export const LLM_BUSY_MESSAGE = 'Another Code Insights LLM operation is already running. Try again when it finishes.';

export interface LlmBusyPayload {
  error: string;
  code: typeof LLM_BUSY_CODE;
}

export type LockedResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

let activeInProcess = false;

export function llmBusyPayload(): LlmBusyPayload {
  return { error: LLM_BUSY_MESSAGE, code: LLM_BUSY_CODE };
}

export function acquireServerLlmLock(c?: Context): LlmLockHandle | null {
  if (activeInProcess) return null;

  const requestToken = c?.req.header(LLM_LOCK_TOKEN_HEADER);
  const ownsGlobalLock = !!requestToken && isLlmLockTokenOwner(requestToken);
  const globalLock = ownsGlobalLock
    ? { release: () => {} }
    : acquireLlmLock();
  if (!globalLock) return null;

  activeInProcess = true;
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        globalLock.release();
      } finally {
        activeInProcess = false;
      }
    },
  };
}

export async function runWithLlmLock<T>(c: Context, operation: () => Promise<T>): Promise<LockedResult<T>> {
  const lock = acquireServerLlmLock(c);
  if (!lock) return { acquired: false };

  try {
    return { acquired: true, value: await operation() };
  } finally {
    lock.release();
  }
}
