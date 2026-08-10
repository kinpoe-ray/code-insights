import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import type { Message } from '@/lib/types';
import {
  buildConversationOutline,
  ConversationOutline,
  summarizeConversationTurn,
} from './ConversationOutline';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'message-1',
    session_id: 'session-1',
    type: 'user',
    content: 'First real prompt',
    thinking: null,
    tool_calls: '[]',
    tool_results: '[]',
    usage: null,
    timestamp: '2026-08-08T08:00:00.000Z',
    parent_id: null,
    ...overrides,
  };
}

describe('conversation outline', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('builds concise entries from real user turns only', () => {
    const messages = [
      message({
        id: 'turn-1',
        content: '<in-app-browser-context>ambient browser state</in-app-browser-context>\n\n## My request:\nFix the session navigator',
      }),
      message({ id: 'assistant-1', type: 'assistant', content: 'Working on it.' }),
      message({ id: 'compact', content: 'This session is being continued from an earlier context window.' }),
      message({ id: 'command', content: '<command-name>/help</command-name>' }),
      message({ id: 'agent', content: '<task-notification><summary>done</summary></task-notification>' }),
      message({ id: 'turn-2', content: 'Add keyboard navigation too.' }),
    ];

    expect(buildConversationOutline(messages, 'Untitled prompt')).toEqual([
      expect.objectContaining({ id: 'turn-1', number: 1, title: 'Fix the session navigator' }),
      expect.objectContaining({ id: 'turn-2', number: 2, title: 'Add keyboard navigation too.' }),
    ]);
  });

  it('uses a fallback for non-text prompts and truncates long titles', () => {
    expect(summarizeConversationTurn('![attached image](image.png)', 'Untitled prompt')).toBe('Untitled prompt');
    expect(Array.from(summarizeConversationTurn('长'.repeat(90), 'Untitled prompt')).length).toBe(69);
  });

  it('scrolls to a selected turn and exposes top/latest shortcuts', () => {
    const scrollTo = vi.fn();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const items = buildConversationOutline([
      message({ id: 'turn-1', content: 'First real prompt' }),
      message({ id: 'turn-2', content: 'Second real prompt', timestamp: '2026-08-08T09:00:00.000Z' }),
    ], 'Untitled prompt');

    function Harness() {
      const scrollRef = useRef<HTMLDivElement>(null);
      return (
        <div
          ref={(node) => {
            scrollRef.current = node;
            if (!node) return;
            node.scrollTo = scrollTo;
            Object.defineProperties(node, {
              clientHeight: { configurable: true, value: 600 },
              scrollHeight: { configurable: true, value: 1800 },
              scrollTop: { configurable: true, value: 100, writable: true },
            });
          }}
        >
          <div id="msg-turn-1">first</div>
          <div id="msg-turn-2">second</div>
          <ConversationOutline
            items={items}
            scrollContainerRef={scrollRef}
            onNavigate={onNavigate}
            onClose={onClose}
          />
        </div>
      );
    }

    render(
      <LocaleProvider>
        <Harness />
      </LocaleProvider>,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    onClose.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Jump to turn 2: Second real prompt' }));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    expect(onNavigate).toHaveBeenCalledWith('turn-2');
    expect(onClose).toHaveBeenCalled();

    const farTarget = document.getElementById('msg-turn-2');
    if (!farTarget) throw new Error('Expected second conversation turn');
    farTarget.getBoundingClientRect = vi.fn(() => ({ top: 5_000 } as DOMRect));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to turn 2: Second real prompt' }));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }));

    fireEvent.click(screen.getByRole('button', { name: 'Top' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });

    fireEvent.click(screen.getByRole('button', { name: 'Latest' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1800, behavior: 'smooth' });
  });
});
