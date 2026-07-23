import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { EmptySessions } from '@/components/empty-states/EmptySessions';
import { CompactSessionRow } from './CompactSessionRow';
import { VitalsStrip } from './VitalsStrip';
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

function LanguageSwitch() {
  const { setLocale } = useLocale();
  return (
    <button data-testid="language-switch" type="button" onClick={() => setLocale('zh-CN')}>
      switch
    </button>
  );
}

describe('Sessions surface language', () => {
  it('localizes visible session copy while keeping source data unchanged', () => {
    localStorage.setItem('code-insights.locale', 'en-US');

    render(
      <LocaleProvider>
        <LanguageSwitch />
        <CompactSessionRow
          session={session}
          isActive={false}
          showProject
          isQueued
          onClick={() => undefined}
        />
        <VitalsStrip session={session} />
        <EmptySessions />
      </LocaleProvider>,
    );

    expect(screen.getByText('8 msgs')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByText('No sessions found')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('language-switch'));

    expect(screen.getByText('8 条消息')).toBeInTheDocument();
    expect(screen.getByText('深度专注')).toBeInTheDocument();
    expect(screen.getByText('分析中…')).toBeInTheDocument();
    expect(screen.getByText('时长')).toBeInTheDocument();
    expect(screen.getByText('消息')).toBeInTheDocument();
    expect(screen.getByText('词元')).toBeInTheDocument();
    expect(screen.getByText('成本')).toBeInTheDocument();
    expect(screen.getByText('没有找到会话')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('Codex CLI')).toBeInTheDocument();
    expect(session.source_tool).toBe('codex-cli');
    expect(session.session_character).toBe('deep_focus');
  });
});
