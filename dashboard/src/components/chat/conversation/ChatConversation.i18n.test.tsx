import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import type { Message } from '@/lib/types';
import { ChatConversation } from './ChatConversation';

function LanguageSwitch() {
  const { setLocale } = useLocale();
  return <button onClick={() => setLocale('zh-CN')}>switch</button>;
}

const message: Message = {
  id: 'message-1',
  session_id: 'session-1',
  type: 'user',
  content: 'Keep this historical message unchanged.',
  thinking: null,
  tool_calls: '[]',
  tool_results: '[]',
  usage: null,
  timestamp: '2026-07-22T08:00:00.000Z',
  parent_id: null,
};

describe('chat conversation language', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('translates viewer controls without rewriting historical messages', async () => {
    const user = userEvent.setup();

    render(
      <LocaleProvider>
        <LanguageSwitch />
        <ChatConversation messages={[message]} />
      </LocaleProvider>,
    );

    expect(screen.getByText('Show raw messages')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'switch' }));

    expect(screen.getByText('显示原始消息')).toBeInTheDocument();
    expect(screen.getByText(message.content)).toBeInTheDocument();
  });
});
