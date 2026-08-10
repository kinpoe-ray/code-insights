import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ListTree,
  Loader2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
import type { Message } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  classifyUserMessage,
  isAgentMessage,
  preprocessUserContent,
} from '../message/preprocess';

const CONTEXT_BLOCK_PATTERNS = [
  /<in-app-browser-context[^>]*>[\s\S]*?<\/in-app-browser-context>/gi,
  /<environment_context[^>]*>[\s\S]*?<\/environment_context>/gi,
  /<recommended_plugins[^>]*>[\s\S]*?<\/recommended_plugins>/gi,
];

const TITLE_LENGTH = 68;
const MAX_SMOOTH_JUMP_VIEWPORTS = 3;

function getJumpBehavior(scroller: HTMLDivElement, targetTop: number): ScrollBehavior {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'auto';
  const maxSmoothDistance = scroller.clientHeight * MAX_SMOOTH_JUMP_VIEWPORTS;
  return Math.abs(targetTop - scroller.scrollTop) > maxSmoothDistance ? 'auto' : 'smooth';
}

export interface ConversationOutlineItem {
  id: string;
  number: number;
  title: string;
  timestamp: string;
}

export function summarizeConversationTurn(content: string, fallback: string): string {
  let text = preprocessUserContent(content);
  for (const pattern of CONTEXT_BLOCK_PATTERNS) text = text.replace(pattern, ' ');

  const requestMarker = /(?:^|\n)#{1,6}\s*(?:my request|我的请求)\s*:?\s*\n?([\s\S]*)$/i.exec(text);
  if (requestMarker) text = requestMarker[1];

  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/[`*_>#~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return fallback;
  const characters = Array.from(text);
  return characters.length > TITLE_LENGTH
    ? `${characters.slice(0, TITLE_LENGTH).join('').trim()}…`
    : text;
}

export function buildConversationOutline(
  messages: Message[],
  fallback: string,
): ConversationOutlineItem[] {
  const turns = messages.filter((message) => {
    if (message.type !== 'user' || !message.content.trim()) return false;
    if (isAgentMessage(message.content)) return false;
    return classifyUserMessage(message.content).kind === 'human';
  });

  return turns.map((message, index) => ({
    id: message.id,
    number: index + 1,
    title: summarizeConversationTurn(message.content, fallback),
    timestamp: message.timestamp,
  }));
}

interface ConversationOutlineProps {
  items: ConversationOutlineItem[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  isLoadingAll?: boolean;
  onNavigate?: (messageId: string) => void;
  onClose: () => void;
  className?: string;
}

export function ConversationOutline({
  items,
  scrollContainerRef,
  isLoadingAll = false,
  onNavigate,
  onClose,
  className,
}: ConversationOutlineProps) {
  const { t, formatDate } = useLocale();
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!items.some((item) => item.id === activeId)) {
      setActiveId(items[0]?.id ?? null);
    }
  }, [activeId, items]);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller || items.length === 0) return;

    let frame = 0;
    const updateActiveTurn = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const scrollerRect = scroller.getBoundingClientRect();
        const threshold = scrollerRect.top + Math.min(140, scrollerRect.height * 0.22);
        let nextActive = items[0].id;

        for (const item of items) {
          const target = document.getElementById(`msg-${item.id}`);
          if (!target || !scroller.contains(target)) continue;
          if (target.getBoundingClientRect().top <= threshold) nextActive = item.id;
          else break;
        }

        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24) {
          nextActive = items[items.length - 1].id;
        }
        setActiveId(nextActive);
      });
    };

    updateActiveTurn();
    scroller.addEventListener('scroll', updateActiveTurn, { passive: true });
    window.addEventListener('resize', updateActiveTurn);
    return () => {
      window.cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', updateActiveTurn);
      window.removeEventListener('resize', updateActiveTurn);
    };
  }, [items, scrollContainerRef]);

  const closeAfterMobileNavigation = useCallback(() => {
    if (!window.matchMedia?.('(min-width: 1536px)').matches) onClose();
  }, [onClose]);

  const scrollToMessage = useCallback((messageId: string) => {
    const scroller = scrollContainerRef.current;
    const target = document.getElementById(`msg-${messageId}`);
    if (!scroller || !target || !scroller.contains(target)) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = scroller.scrollTop + targetRect.top - scrollerRect.top - 12;
    scroller.scrollTo({
      top: targetTop,
      behavior: getJumpBehavior(scroller, targetTop),
    });
    setActiveId(messageId);
    onNavigate?.(messageId);
    closeAfterMobileNavigation();
  }, [closeAfterMobileNavigation, onNavigate, scrollContainerRef]);

  const scrollToEdge = useCallback((edge: 'top' | 'bottom') => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return;
    const targetTop = edge === 'top' ? 0 : scroller.scrollHeight;
    scroller.scrollTo({
      top: targetTop,
      behavior: getJumpBehavior(scroller, targetTop),
    });
    setActiveId(edge === 'top' ? items[0]?.id ?? null : items[items.length - 1]?.id ?? null);
    closeAfterMobileNavigation();
  }, [closeAfterMobileNavigation, items, scrollContainerRef]);

  const formattedItems = useMemo(() => items.map((item) => ({
    ...item,
    time: formatDate(item.timestamp, { hour: 'numeric', minute: '2-digit' }),
  })), [formatDate, items]);

  return (
    <aside
      id="conversation-outline"
      className={cn('flex h-full flex-col border-l bg-background', className)}
      aria-labelledby="conversation-outline-title"
      data-testid="conversation-outline"
    >
      <div className="shrink-0 border-b px-3.5 pb-3 pt-3.5">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ListTree className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 id="conversation-outline-title" className="text-sm font-semibold">
                {t('chat.outline.title')}
              </h3>
              <span className="font-tabular text-[11px] text-muted-foreground">
                {t('chat.outline.turnCount', { count: items.length })}
              </span>
              {isLoadingAll && (
                <Loader2 aria-label={t('chat.outline.loading')} className="h-3.5 w-3.5 animate-spin text-primary" />
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              {t('chat.outline.description')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-mr-1 -mt-1 text-muted-foreground"
            aria-label={t('chat.outline.close')}
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label={t('chat.outline.title')}>
        {formattedItems.length > 0 ? (
          <ol className="space-y-0.5">
            {formattedItems.map((item) => {
              const active = item.id === activeId;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={cn(
                      'group relative flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-[background-color,color,transform] hover:bg-muted/70 active:scale-[0.99] focus-visible:ring-3 focus-visible:ring-ring/35 motion-reduce:transition-none',
                      active && 'bg-accent text-accent-foreground',
                    )}
                    aria-current={active ? 'location' : undefined}
                    aria-label={t('chat.outline.jumpToTurn', { number: item.number, title: item.title })}
                    onClick={() => scrollToMessage(item.id)}
                  >
                    {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" />}
                    <span className={cn(
                      'font-tabular mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold',
                      active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:text-foreground',
                    )}>
                      {item.number}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 block text-xs font-medium leading-[1.15rem]">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        {item.time}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="px-3 py-8 text-center text-xs leading-5 text-muted-foreground">
            {isLoadingAll ? t('chat.outline.loading') : t('chat.outline.empty')}
          </div>
        )}
      </nav>

      <div className="grid shrink-0 grid-cols-2 gap-1.5 border-t p-2.5">
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => scrollToEdge('top')}>
          <ArrowUpToLine className="h-3.5 w-3.5" />
          {t('chat.outline.top')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={isLoadingAll}
          onClick={() => scrollToEdge('bottom')}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
          {t('chat.outline.latest')}
        </Button>
      </div>
    </aside>
  );
}
