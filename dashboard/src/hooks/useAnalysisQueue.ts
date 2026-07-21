import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAnalysisQueue } from '@/lib/api';
import type {
  AnalysisBatchReceipt,
  AnalysisQueueStatus,
} from '@/lib/api';

export const ANALYSIS_BATCH_RECEIPT_KEY =
  'code-insights.analysis.last-batch';
const ANALYSIS_BATCH_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

export interface AnalysisBatchProgress {
  total: number;
  queued: number;
  alreadyActive: number;
  pending: number;
  processing: number;
  failed: number;
  completed: number;
  finished: number;
  isComplete: boolean;
  errors: Array<{ sessionId: string; message: string }>;
}

function receiptKey(receipt: AnalysisBatchReceipt): string {
  return `${receipt.enqueuedAt}:${receipt.sessionIds.join('\0')}`;
}

function receiptTimestamp(enqueuedAt: string): number {
  const sqliteTimestamp =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(enqueuedAt)
      ? `${enqueuedAt.replace(' ', 'T')}Z`
      : enqueuedAt;
  return Date.parse(sqliteTimestamp);
}

function isAnalysisBatchReceipt(value: unknown): value is AnalysisBatchReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<AnalysisBatchReceipt>;
  return (
    Array.isArray(receipt.sessionIds)
    && receipt.sessionIds.length > 0
    && receipt.sessionIds.every((sessionId) => typeof sessionId === 'string')
    && typeof receipt.queued === 'number'
    && typeof receipt.alreadyActive === 'number'
    && typeof receipt.enqueuedAt === 'string'
  );
}

export function loadAnalysisBatchReceipt(
  now = Date.now(),
): AnalysisBatchReceipt | null {
  try {
    const stored = localStorage.getItem(ANALYSIS_BATCH_RECEIPT_KEY);
    if (!stored) return null;
    const receipt = JSON.parse(stored) as unknown;
    if (!isAnalysisBatchReceipt(receipt)) {
      localStorage.removeItem(ANALYSIS_BATCH_RECEIPT_KEY);
      return null;
    }
    const enqueuedAt = receiptTimestamp(receipt.enqueuedAt);
    if (
      !Number.isFinite(enqueuedAt)
      || now - enqueuedAt >= ANALYSIS_BATCH_RECEIPT_TTL_MS
      || enqueuedAt > now
    ) {
      localStorage.removeItem(ANALYSIS_BATCH_RECEIPT_KEY);
      return null;
    }
    return receipt;
  } catch {
    return null;
  }
}

export function saveAnalysisBatchReceipt(
  receipt: AnalysisBatchReceipt,
): void {
  try {
    localStorage.setItem(
      ANALYSIS_BATCH_RECEIPT_KEY,
      JSON.stringify(receipt),
    );
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // in-memory receipt still tracks the current dashboard lifetime.
  }
}

export function clearAnalysisBatchReceipt(): void {
  try {
    localStorage.removeItem(ANALYSIS_BATCH_RECEIPT_KEY);
  } catch {
    // Keep the in-memory state authoritative when storage is unavailable.
  }
}

export function deriveAnalysisBatchProgress(
  receipt: AnalysisBatchReceipt,
  queue: AnalysisQueueStatus,
): AnalysisBatchProgress {
  const receiptSessionIds = new Set(receipt.sessionIds);
  const relevantItems = queue.items.filter(
    (item) => receiptSessionIds.has(item.session_id),
  );
  const pending = relevantItems.filter(
    (item) => item.status === 'pending',
  ).length;
  const processing = relevantItems.filter(
    (item) => item.status === 'processing',
  ).length;
  const failedItems = relevantItems.filter(
    (item) => item.status === 'failed',
  );
  const failed = failedItems.length;
  const total = receipt.sessionIds.length;
  // GET intentionally omits completed rows. Every receipt id absent from the
  // active/failed subset therefore represents completed durable work.
  const completed = Math.max(0, total - pending - processing - failed);

  return {
    total,
    queued: receipt.queued,
    alreadyActive: receipt.alreadyActive,
    pending,
    processing,
    failed,
    completed,
    finished: completed + failed,
    isComplete: pending + processing === 0,
    errors: failedItems.map((item) => ({
      sessionId: item.session_id,
      message: item.error_message ?? 'Analysis failed',
    })),
  };
}

/**
 * Polls GET /api/analysis/queue to track async analysis progress.
 *
 * Polling behavior:
 * - Refetches every 5s when there are pending or processing items.
 * - Stops polling (refetchInterval = false) when both reach 0.
 * - Always fetches once on mount to check initial state.
 *
 * When the queue drains (active items drop to 0), invalidates 'sessions' and
 * 'insights' query keys so new analysis results appear immediately without
 * requiring navigation or manual refresh.
 */
export function useAnalysisQueue() {
  const queryClient = useQueryClient();
  const wasActiveRef = useRef(false);

  const result = useQuery<AnalysisQueueStatus>({
    queryKey: ['analysisQueue'],
    queryFn: fetchAnalysisQueue,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000; // Fetch once on mount, then poll if needed
      const isActive = data.pending > 0 || data.processing > 0;
      return isActive ? 5000 : false;
    },
    // Stale immediately so each manual refetch gets fresh data
    staleTime: 0,
  });

  const isActive = result.data
    ? result.data.pending > 0 || result.data.processing > 0
    : false;

  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      // Queue just drained — invalidate so insights and session list refresh
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
    }
    wasActiveRef.current = isActive;
  }, [isActive, queryClient]);

  return result;
}

/**
 * Returns the set of session IDs currently in the queue (pending or processing).
 * Used by session list/detail to show "Analyzing..." badges.
 */
export function useQueuedSessionIds(): Set<string> {
  const { data } = useAnalysisQueue();
  return useMemo(() => {
    if (!data) return new Set<string>();
    return new Set(
      data.items
        .filter(item => item.status === 'pending' || item.status === 'processing')
        .map(item => item.session_id)
    );
  }, [data]);
}

export function useAnalysisBatchQueue({
  onComplete,
  sessionIds,
}: {
  onComplete?: () => void;
  sessionIds?: string[];
} = {}) {
  const queryClient = useQueryClient();
  const queue = useAnalysisQueue();
  const [receipt, setReceipt] = useState<AnalysisBatchReceipt | null>(
    () => loadAnalysisBatchReceipt(),
  );
  const completedReceiptRef = useRef<string | null>(null);
  const restoredReceiptKeyRef = useRef<string | null>(
    receipt ? receiptKey(receipt) : null,
  );
  const pendingSnapshotKeyRef = useRef<string | null>(
    restoredReceiptKeyRef.current,
  );
  const [pendingSnapshotKey, setPendingSnapshotKey] =
    useState<string | null>(restoredReceiptKeyRef.current);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const matchingReceipt = useMemo(() => {
    if (!receipt || !sessionIds) return receipt;
    if (receipt.sessionIds.length !== sessionIds.length) return null;
    const expectedIds = new Set(sessionIds);
    return receipt.sessionIds.every((sessionId) => expectedIds.has(sessionId))
      ? receipt
      : null;
  }, [receipt, sessionIds]);
  const matchingReceiptKey = matchingReceipt
    ? receiptKey(matchingReceipt)
    : null;

  const progress = useMemo(
    () => (
      matchingReceipt && queue.data
        && pendingSnapshotKey !== matchingReceiptKey
        ? deriveAnalysisBatchProgress(matchingReceipt, queue.data)
        : null
    ),
    [matchingReceipt, matchingReceiptKey, pendingSnapshotKey, queue.data],
  );

  useEffect(() => {
    const restoredKey = restoredReceiptKeyRef.current;
    if (
      !restoredKey
      || pendingSnapshotKey !== restoredKey
      || !queue.isFetchedAfterMount
      || !queue.isSuccess
      || queue.isFetching
    ) {
      return;
    }
    restoredReceiptKeyRef.current = null;
    pendingSnapshotKeyRef.current = null;
    setPendingSnapshotKey(null);
  }, [
    pendingSnapshotKey,
    queue.isFetchedAfterMount,
    queue.isFetching,
    queue.isSuccess,
  ]);

  useEffect(() => {
    if (!matchingReceipt || !progress?.isComplete) return;
    const completedKey = receiptKey(matchingReceipt);
    if (completedReceiptRef.current === completedKey) return;
    completedReceiptRef.current = completedKey;
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    void queryClient.invalidateQueries({ queryKey: ['insights'] });
    onCompleteRef.current?.();
  }, [matchingReceipt, progress?.isComplete, queryClient]);

  const refreshSnapshotFor = useCallback((
    targetReceipt: AnalysisBatchReceipt,
  ) => {
    const targetKey = receiptKey(targetReceipt);
    pendingSnapshotKeyRef.current = targetKey;
    setPendingSnapshotKey(targetKey);
    void queue.refetch({ cancelRefetch: true }).then((result) => {
      if (
        result.isSuccess
        && pendingSnapshotKeyRef.current === targetKey
      ) {
        pendingSnapshotKeyRef.current = null;
        setPendingSnapshotKey(null);
      }
    });
  }, [queue]);

  const rememberReceipt = useCallback((
    nextReceipt: AnalysisBatchReceipt,
  ) => {
    saveAnalysisBatchReceipt(nextReceipt);
    completedReceiptRef.current = null;
    restoredReceiptKeyRef.current = null;
    setReceipt(nextReceipt);
    refreshSnapshotFor(nextReceipt);
  }, [refreshSnapshotFor]);

  const retrySnapshot = useCallback(() => {
    if (matchingReceipt) refreshSnapshotFor(matchingReceipt);
  }, [matchingReceipt, refreshSnapshotFor]);

  const clearReceipt = useCallback(() => {
    clearAnalysisBatchReceipt();
    completedReceiptRef.current = null;
    restoredReceiptKeyRef.current = null;
    pendingSnapshotKeyRef.current = null;
    setPendingSnapshotKey(null);
    setReceipt(null);
  }, []);

  return {
    ...queue,
    receipt: matchingReceipt,
    progress,
    rememberReceipt,
    retrySnapshot,
    clearReceipt,
    isAwaitingFreshSnapshot:
      matchingReceiptKey !== null
      && pendingSnapshotKey === matchingReceiptKey,
  };
}
