import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnalysisBatchReceipt,
  AnalysisQueueStatus,
} from '@/lib/api';

const fetchAnalysisQueue = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    fetchAnalysisQueue,
  };
});

const {
  ANALYSIS_BATCH_RECEIPT_KEY,
  deriveAnalysisBatchProgress,
  loadAnalysisBatchReceipt,
  saveAnalysisBatchReceipt,
  useAnalysisBatchQueue,
} = await import('./useAnalysisQueue');

const receipt: AnalysisBatchReceipt = {
  sessionIds: ['pending', 'processing', 'failed', 'completed'],
  queued: 3,
  alreadyActive: 1,
  enqueuedAt: '2026-07-18 10:00:00',
};

function queueStatus(
  items: AnalysisQueueStatus['items'],
): AnalysisQueueStatus {
  return {
    pending: items.filter((item) => item.status === 'pending').length,
    processing: items.filter((item) => item.status === 'processing').length,
    completed: 100,
    failed: items.filter((item) => item.status === 'failed').length,
    nextAttemptAt: null,
    items,
  };
}

function item(
  sessionId: string,
  status: 'pending' | 'processing' | 'failed',
  errorMessage: string | null = null,
): AnalysisQueueStatus['items'][number] {
  return {
    session_id: sessionId,
    status,
    runner_type: 'provider',
    enqueued_at: '2026-07-18 10:00:00',
    started_at: status === 'processing' ? '2026-07-18 10:01:00' : null,
    completed_at: null,
    error_message: errorMessage,
    attempt_count: status === 'failed' ? 3 : 0,
    max_attempts: 3,
    rerun_requested: 0,
    next_attempt_at: null,
  };
}

describe('analysis batch receipt progress', () => {
  beforeEach(() => {
    // Keep the persisted receipt inside its 24-hour lifetime. Without a
    // pinned clock, this fixture silently expires as the calendar advances.
    vi.setSystemTime(new Date('2026-07-18T11:00:00Z'));
    localStorage.clear();
    fetchAnalysisQueue.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses receipt ids and ignores unrelated queue rows', () => {
    const progress = deriveAnalysisBatchProgress(receipt, queueStatus([
      item('pending', 'pending'),
      item('processing', 'processing'),
      item('failed', 'failed', 'provider timeout'),
      item('another-batch', 'processing'),
    ]));

    expect(progress).toEqual({
      total: 4,
      queued: 3,
      alreadyActive: 1,
      pending: 1,
      processing: 1,
      failed: 1,
      completed: 1,
      finished: 2,
      isComplete: false,
      errors: [{ sessionId: 'failed', message: 'provider timeout' }],
    });
  });

  it('infers omitted receipt items are completed when GET excludes completed rows', () => {
    const progress = deriveAnalysisBatchProgress(
      receipt,
      queueStatus([]),
    );

    expect(progress.completed).toBe(4);
    expect(progress.finished).toBe(4);
    expect(progress.isComplete).toBe(true);
  });

  it('persists the last receipt for 24 hours without changing session ids', () => {
    saveAnalysisBatchReceipt(receipt);

    expect(loadAnalysisBatchReceipt(
      Date.parse('2026-07-19T09:59:59Z'),
    )).toEqual(receipt);
    expect(loadAnalysisBatchReceipt(
      Date.parse('2026-07-19T10:00:00Z'),
    )).toBeNull();
    expect(localStorage.getItem(ANALYSIS_BATCH_RECEIPT_KEY)).toBeNull();
  });

  it('refreshes insights and sessions when a restored batch is complete', async () => {
    saveAnalysisBatchReceipt(receipt);
    fetchAnalysisQueue.mockResolvedValue(queueStatus([]));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const onComplete = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => useAnalysisBatchQueue({
        onComplete,
        sessionIds: receipt.sessionIds,
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.progress?.isComplete).toBe(true);
    });
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['insights'] });
  });

  it('waits for a fresh queue snapshot before completing a restored receipt', async () => {
    saveAnalysisBatchReceipt(receipt);
    const oldEmptySnapshot = queueStatus([]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['analysisQueue'], oldEmptySnapshot);
    let resolveFresh!: (value: AnalysisQueueStatus) => void;
    fetchAnalysisQueue.mockReturnValue(new Promise<AnalysisQueueStatus>(
      (resolve) => {
        resolveFresh = resolve;
      },
    ));
    const onComplete = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => useAnalysisBatchQueue({
        onComplete,
        sessionIds: receipt.sessionIds,
      }),
      { wrapper },
    );

    expect(result.current.progress).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchAnalysisQueue).toHaveBeenCalled());

    resolveFresh(queueStatus([item('pending', 'pending')]));
    await waitFor(() => {
      expect(result.current.progress?.pending).toBe(1);
    });
    expect(result.current.progress?.isComplete).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('keeps a restored receipt gated after refresh failure and allows retry', async () => {
    saveAnalysisBatchReceipt(receipt);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['analysisQueue'], queueStatus([]));
    fetchAnalysisQueue.mockRejectedValueOnce(new Error('queue offline'));
    const onComplete = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => useAnalysisBatchQueue({
        onComplete,
        sessionIds: receipt.sessionIds,
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.error).toEqual(new Error('queue offline'));
    });
    expect(result.current.progress).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    fetchAnalysisQueue.mockResolvedValueOnce(
      queueStatus([item('pending', 'pending')]),
    );
    act(() => {
      result.current.retrySnapshot();
    });

    await waitFor(() => {
      expect(result.current.progress?.pending).toBe(1);
    });
    expect(result.current.error).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('waits for a fresh queue snapshot after POST before inferring completion', async () => {
    const empty = queueStatus([]);
    fetchAnalysisQueue.mockResolvedValueOnce(empty);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['analysisQueue'], empty);
    const onComplete = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
    let resolveFresh!: (value: AnalysisQueueStatus) => void;
    const freshSnapshot = new Promise<AnalysisQueueStatus>((resolve) => {
      resolveFresh = resolve;
    });
    const { result } = renderHook(
      () => useAnalysisBatchQueue({
        onComplete,
        sessionIds: ['new-session'],
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    fetchAnalysisQueue.mockReturnValueOnce(freshSnapshot);
    const newReceipt: AnalysisBatchReceipt = {
      sessionIds: ['new-session'],
      queued: 1,
      alreadyActive: 0,
      enqueuedAt: '2026-07-18 11:00:00',
    };

    act(() => {
      result.current.rememberReceipt(newReceipt);
    });

    expect(result.current.progress).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    resolveFresh(empty);
    await waitFor(() => {
      expect(result.current.progress?.isComplete).toBe(true);
    });
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
