import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnalysisBatchReceipt,
  AnalysisQueueStatus,
} from '@/lib/api';
import type { LLMConfig, Session } from '@/lib/types';
import { ANALYSIS_BATCH_RECEIPT_KEY } from '@/hooks/useAnalysisQueue';
import { BulkAnalyzeButton } from './BulkAnalyzeButton';
import { LocaleProvider } from '@/i18n/LocaleProvider';

const enqueueAnalysisBatch = vi.hoisted(() => vi.fn());
const fetchAnalysisQueue = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    enqueueAnalysisBatch,
    fetchAnalysisQueue,
  };
});

const configuredLlm = {
  dashboardPort: 7890,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
} satisfies LLMConfig;

const emptyQueue: AnalysisQueueStatus = {
  pending: 0,
  processing: 0,
  completed: 0,
  failed: 0,
  nextAttemptAt: null,
  items: [],
};

function makeSession(id: string): Session {
  return {
    id,
    project_id: 'proj-1',
    project_name: 'Test Project',
    project_path: '/test',
    git_remote_url: null,
    summary: null,
    custom_title: null,
    generated_title: 'Test Session',
    title_source: 'fallback',
    session_character: null,
    started_at: '2026-01-01T00:00:00Z',
    ended_at: '2026-01-01T01:00:00Z',
    message_count: 10,
    user_message_count: 5,
    assistant_message_count: 5,
    tool_call_count: 2,
    git_branch: null,
    claude_version: null,
    source_tool: 'claude-code',
    device_id: null,
    device_hostname: null,
    device_platform: null,
    synced_at: '2026-01-01T01:00:00Z',
    total_input_tokens: null,
    total_output_tokens: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    estimated_cost_usd: null,
    models_used: null,
    primary_model: null,
    usage_source: null,
    compact_count: 0,
    auto_compact_count: 0,
    slash_commands: null,
  };
}

function queueWith(
  entries: Array<{
    sessionId: string;
    status: 'pending' | 'processing' | 'failed';
    error?: string;
  }>,
): AnalysisQueueStatus {
  return {
    pending: entries.filter(({ status }) => status === 'pending').length,
    processing: entries.filter(({ status }) => status === 'processing').length,
    completed: 0,
    failed: entries.filter(({ status }) => status === 'failed').length,
    nextAttemptAt: null,
    items: entries.map(({ sessionId, status, error }) => ({
      session_id: sessionId,
      status,
      runner_type: 'provider',
      enqueued_at: '2026-07-18 12:00:00',
      started_at: status === 'processing' ? '2026-07-18 12:01:00' : null,
      completed_at: null,
      error_message: error ?? null,
      attempt_count: status === 'failed' ? 3 : 0,
      max_attempts: 3,
      rerun_requested: 0,
      next_attempt_at: null,
    })),
  };
}

function makeReceipt(sessionIds: string[]): AnalysisBatchReceipt {
  return {
    sessionIds,
    queued: sessionIds.length,
    alreadyActive: 0,
    enqueuedAt: new Date().toISOString(),
  };
}

function setup(
  sessions: Session[],
  options: {
    onComplete?: () => void;
    llmConfig?: LLMConfig;
    queue?: AnalysisQueueStatus;
  } = {},
) {
  fetchAnalysisQueue.mockResolvedValue(options.queue ?? emptyQueue);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
  queryClient.setQueryData(
    ['config', 'llm'],
    options.llmConfig ?? configuredLlm,
  );
  queryClient.setQueryData(
    ['analysisQueue'],
    options.queue ?? emptyQueue,
  );
  render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <BulkAnalyzeButton
          sessions={sessions}
          onComplete={options.onComplete}
        />
      </LocaleProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fetchAnalysisQueue.mockResolvedValue(emptyQueue);
});

describe('BulkAnalyzeButton durable batches', () => {
  it('is disabled until AI is configured', () => {
    setup([makeSession('s1')], {
      llmConfig: { dashboardPort: 7890 },
    });

    expect(screen.getByRole(
      'button',
      { name: /analyze selected/i },
    )).toBeDisabled();
  });

  it('keeps singular, plural, and empty trigger states', () => {
    const { unmount } = renderWithSessions([]);
    expect(screen.getByRole(
      'button',
      { name: /analyze 0 sessions/i },
    )).toBeDisabled();
    unmount();

    const one = renderWithSessions([makeSession('s1')]);
    expect(screen.getByRole(
      'button',
      { name: /analyze 1 session$/i },
    )).toBeEnabled();
    one.unmount();

    renderWithSessions([makeSession('s1'), makeSession('s2')]);
    expect(screen.getByRole(
      'button',
      { name: /analyze 2 sessions/i },
    )).toBeEnabled();
  });

  it('renders batch analysis controls in Chinese when selected', () => {
    localStorage.setItem('code-insights.locale', 'zh-CN');
    renderWithSessions([makeSession('s1'), makeSession('s2')]);

    expect(screen.getByRole('button', { name: '分析 2 个会话' })).toBeInTheDocument();
  });

  it('submits all ids in one POST and stores the returned receipt', async () => {
    const sessions = [makeSession('s1'), makeSession('s2')];
    const receipt = makeReceipt(['s1', 's2']);
    enqueueAnalysisBatch.mockResolvedValue({ batch: receipt });
    setup(sessions, {
      queue: queueWith([
        { sessionId: 's1', status: 'pending' },
        { sessionId: 's2', status: 'pending' },
      ]),
    });

    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze 2 sessions/i },
    ));
    await userEvent.click(screen.getByRole(
      'button',
      { name: /start analysis/i },
    ));

    await waitFor(() => {
      expect(enqueueAnalysisBatch).toHaveBeenCalledOnce();
    });
    expect(enqueueAnalysisBatch).toHaveBeenCalledWith(['s1', 's2']);
    expect(JSON.parse(
      localStorage.getItem(ANALYSIS_BATCH_RECEIPT_KEY)!,
    )).toEqual(receipt);
    expect(screen.getByText(/0 of 2 finished/i)).toBeInTheDocument();
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '2');
    expect(progressbar).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText(/0 of 2 finished/i)).toHaveAttribute(
      'aria-live',
      'polite',
    );
    expect(screen.queryByRole(
      'button',
      { name: /cancel|retry/i },
    )).not.toBeInTheDocument();
  });

  it('can close an active batch and reopen its durable progress', async () => {
    const receipt = makeReceipt(['s1']);
    enqueueAnalysisBatch.mockResolvedValue({ batch: receipt });
    setup([makeSession('s1')], {
      queue: queueWith([{ sessionId: 's1', status: 'processing' }]),
    });

    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze 1 session/i },
    ));
    await userEvent.click(screen.getByRole(
      'button',
      { name: /start analysis/i },
    ));
    await screen.findByText(/0 of 1 finished/i);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze 1 session/i },
    ));
    expect(screen.getByText(/0 of 1 finished/i)).toBeInTheDocument();
  });

  it('infers completion from omitted queue rows and refreshes once', async () => {
    const receipt = makeReceipt(['s1', 's2']);
    enqueueAnalysisBatch.mockResolvedValue({ batch: receipt });
    const onComplete = vi.fn();
    const queryClient = setup(
      [makeSession('s1'), makeSession('s2')],
      {
        onComplete,
        queue: queueWith([
          { sessionId: 's1', status: 'pending' },
          { sessionId: 's2', status: 'processing' },
        ]),
      },
    );

    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze 2 sessions/i },
    ));
    await userEvent.click(screen.getByRole(
      'button',
      { name: /start analysis/i },
    ));
    await screen.findByText(/0 of 2 finished/i);

    act(() => {
      queryClient.setQueryData(['analysisQueue'], emptyQueue);
    });

    await waitFor(() => {
      expect(screen.getByText(
        /2 sessions analyzed successfully/i,
      )).toBeInTheDocument();
    });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('shows terminal failures from SQLite without a retry action', async () => {
    const receipt = makeReceipt(['s1', 's2']);
    enqueueAnalysisBatch.mockResolvedValue({ batch: receipt });
    setup([makeSession('s1'), makeSession('s2')], {
      queue: queueWith([
        { sessionId: 's2', status: 'failed', error: 'provider timeout' },
      ]),
    });

    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze 2 sessions/i },
    ));
    await userEvent.click(screen.getByRole(
      'button',
      { name: /start analysis/i },
    ));

    expect(await screen.findByText(
      /1 session analyzed successfully/i,
    )).toBeInTheDocument();
    expect(screen.getByText(/1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/provider timeout/i)).toBeInTheDocument();
    expect(screen.queryByRole(
      'button',
      { name: /retry|cancel/i },
    )).not.toBeInTheDocument();
  });

  it('allows a different selection after the previous batch completes', async () => {
    const previous = makeReceipt(['batch-a']);
    localStorage.setItem(
      ANALYSIS_BATCH_RECEIPT_KEY,
      JSON.stringify(previous),
    );
    const next = makeReceipt(['batch-b']);
    enqueueAnalysisBatch.mockResolvedValue({ batch: next });
    setup([makeSession('batch-b')]);

    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze 1 session/i },
    ));
    expect(screen.getByRole(
      'button',
      { name: /start analysis/i },
    )).toBeInTheDocument();
    await userEvent.click(screen.getByRole(
      'button',
      { name: /start analysis/i },
    ));

    await waitFor(() => {
      expect(enqueueAnalysisBatch).toHaveBeenCalledWith(['batch-b']);
    });
    expect(JSON.parse(
      localStorage.getItem(ANALYSIS_BATCH_RECEIPT_KEY)!,
    )).toEqual(next);
  });

  it('lets the same selection explicitly clear a completed receipt and analyze again', async () => {
    const previous = makeReceipt(['s1']);
    localStorage.setItem(
      ANALYSIS_BATCH_RECEIPT_KEY,
      JSON.stringify(previous),
    );
    const next = makeReceipt(['s1']);
    enqueueAnalysisBatch.mockResolvedValue({ batch: next });
    setup([makeSession('s1')]);

    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze 1 session/i },
    ));
    await screen.findByText(/1 session analyzed successfully/i);
    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze again/i },
    ));

    expect(localStorage.getItem(ANALYSIS_BATCH_RECEIPT_KEY)).toBeNull();
    await userEvent.click(screen.getByRole(
      'button',
      { name: /start analysis/i },
    ));
    await waitFor(() => {
      expect(enqueueAnalysisBatch).toHaveBeenCalledWith(['s1']);
    });
  });

  it('shows a queue error alert and retries a fresh snapshot', async () => {
    const receipt = makeReceipt(['s1']);
    enqueueAnalysisBatch.mockResolvedValue({ batch: receipt });
    setup([makeSession('s1')], {
      queue: emptyQueue,
    });
    await waitFor(() => expect(fetchAnalysisQueue).toHaveBeenCalled());
    fetchAnalysisQueue.mockRejectedValueOnce(new Error('queue offline'));

    await userEvent.click(screen.getByRole(
      'button',
      { name: /analyze 1 session/i },
    ));
    await userEvent.click(screen.getByRole(
      'button',
      { name: /start analysis/i },
    ));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /queue offline/i,
    );
    fetchAnalysisQueue.mockResolvedValueOnce(queueWith([
      { sessionId: 's1', status: 'pending' },
    ]));
    await userEvent.click(screen.getByRole(
      'button',
      { name: /^retry$/i },
    ));

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

function renderWithSessions(sessions: Session[]) {
  fetchAnalysisQueue.mockResolvedValue(emptyQueue);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
  queryClient.setQueryData(['config', 'llm'], configuredLlm);
  queryClient.setQueryData(['analysisQueue'], emptyQueue);
  return render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <BulkAnalyzeButton sessions={sessions} />
      </LocaleProvider>
    </QueryClientProvider>,
  );
}
