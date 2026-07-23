import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Session } from '@/lib/types';

const session: Session = {
  id: 'session-1',
  project_id: 'project-1',
  project_name: 'alpha',
  project_path: '/projects/alpha',
  git_remote_url: null,
  summary: null,
  custom_title: null,
  generated_title: 'Keep this title',
  title_source: 'claude',
  session_character: 'deep_focus',
  started_at: '2026-07-22T00:15:00.000Z',
  ended_at: '2026-07-22T01:15:00.000Z',
  message_count: 8,
  user_message_count: 3,
  assistant_message_count: 5,
  tool_call_count: 2,
  git_branch: 'feature/stable-key',
  claude_version: null,
  source_tool: 'codex-cli',
  device_id: null,
  device_hostname: null,
  device_platform: null,
  synced_at: '2026-07-22T01:16:00.000Z',
  total_input_tokens: 100,
  total_output_tokens: 50,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  estimated_cost_usd: 0.25,
  models_used: '["glm-5.2"]',
  primary_model: 'glm-5.2',
  usage_source: 'provider',
  compact_count: 0,
  auto_compact_count: 0,
  slash_commands: null,
};

vi.mock('@/hooks/useSessions', () => ({
  useSession: () => ({ data: session, isLoading: false, error: null }),
  useSessionMutation: () => ({}),
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('@/hooks/useInsights', () => ({
  useInsights: () => ({ data: [] }),
}));

vi.mock('@/hooks/useMessages', () => ({
  useMessages: () => ({
    data: { pages: [[]] },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));

vi.mock('@/hooks/useFacets', () => ({
  useMissingFacets: () => ({ data: { sessionIds: [] } }),
  useBackfillFacets: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock('@/hooks/useAnalysisQueue', () => ({
  useQueuedSessionIds: () => new Set<string>(),
}));

vi.mock('@/components/analysis/AnalysisContext', () => ({
  useAnalysis: () => ({ getAnalysisState: () => undefined }),
}));

vi.mock('@/components/analysis/AnalyzeDropdown', () => ({ AnalyzeDropdown: () => null }));
vi.mock('@/components/analysis/AnalyzeButton', () => ({ AnalyzeButton: () => null }));
vi.mock('@/components/sessions/PromptQualityAnalyzeButton', () => ({ PromptQualityAnalyzeButton: () => null }));
vi.mock('@/components/sessions/RenameSessionDialog', () => ({ RenameSessionDialog: () => null }));
vi.mock('@/components/chat/conversation/ChatConversation', () => ({ ChatConversation: () => null }));
vi.mock('@/components/chat/conversation/ConversationSearch', () => ({ ConversationSearch: () => null }));

function LanguageSwitch() {
  const { setLocale } = useLocale();
  return (
    <button data-testid="language-switch" type="button" onClick={() => setLocale('zh-CN')}>
      switch
    </button>
  );
}

describe('Session detail language', () => {
  it('localizes detail navigation and dates while preserving session values', async () => {
    localStorage.setItem('code-insights.locale', 'en-US');
    const { SessionDetailPanel } = await import('./SessionDetailPanel');

    render(
      <MemoryRouter>
        <LocaleProvider>
          <TooltipProvider>
            <LanguageSwitch />
            <SessionDetailPanel sessionId="session-1" />
          </TooltipProvider>
        </LocaleProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: 'Insights' })).toBeInTheDocument();
    expect(screen.getByText(/Jul 22/)).toBeInTheDocument();
    expect(screen.getByText("This session hasn't been analyzed yet")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('language-switch'));

    expect(screen.getByRole('tab', { name: '洞察' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '提示词质量' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '对话（8）' })).toBeInTheDocument();
    expect(screen.getByText(/日/)).toHaveTextContent('7月');
    expect(screen.getByText('深度专注')).toBeInTheDocument();
    expect(screen.getByText('2 次工具调用')).toBeInTheDocument();
    expect(screen.getByText('此会话尚未分析')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('feature/stable-key')).toBeInTheDocument();
    expect(screen.getByText('codex-cli')).toBeInTheDocument();
    expect(session.id).toBe('session-1');
  }, 20_000);
});
