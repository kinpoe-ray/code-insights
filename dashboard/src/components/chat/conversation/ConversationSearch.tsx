import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, ChevronUp, ChevronDown, X, Loader2, ListTree } from 'lucide-react';
import type { Message } from '@/lib/types';
import { useLocale } from '@/i18n/LocaleProvider';

interface ConversationSearchProps {
  messages: Message[];
  onHighlightMessage: (messageId: string | null) => void;
  onSearchQueryChange?: (query: string) => void;
  fetchAllMessages?: () => void;
  isLoadingAll?: boolean;
  outlineCount?: number;
  outlineOpen?: boolean;
  onToggleOutline?: () => void;
}

export function ConversationSearch({
  messages,
  onHighlightMessage,
  onSearchQueryChange,
  fetchAllMessages,
  isLoadingAll,
  outlineCount = 0,
  outlineOpen = false,
  onToggleOutline,
}: ConversationSearchProps) {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const matches = useMemo(
    () =>
      debouncedQuery
        ? messages
            .filter((m) => m.content.toLowerCase().includes(debouncedQuery.toLowerCase()))
            .map((m) => m.id)
        : [],
    [messages, debouncedQuery]
  );

  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
      setMatchIndex(0);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  useEffect(() => {
    onHighlightMessage(matches[matchIndex] ?? null);
  }, [matches, matchIndex, onHighlightMessage]);

  useEffect(() => {
    onSearchQueryChange?.(debouncedQuery);
  }, [debouncedQuery, onSearchQueryChange]);

  const handleInputChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (value && fetchAllMessages) fetchAllMessages();
    },
    [fetchAllMessages]
  );

  const prev = useCallback(() => {
    setMatchIndex((i) => (i > 0 ? i - 1 : matches.length - 1));
  }, [matches.length]);

  const next = useCallback(() => {
    setMatchIndex((i) => (i < matches.length - 1 ? i + 1 : 0));
  }, [matches.length]);

  const clear = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
    setMatchIndex(0);
    onHighlightMessage(null);
    onSearchQueryChange?.('');
  }, [onHighlightMessage, onSearchQueryChange]);

  return (
    <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-4 py-2 flex items-center gap-2">
      <Search className="h-4 w-4 text-muted-foreground shrink-0" />
      <Input
        placeholder={t('chat.search.placeholder')}
        value={query}
        onChange={(e) => handleInputChange(e.target.value)}
        className="h-8 min-w-0 text-sm"
      />
      {isLoadingAll && <Loader2 aria-label={t('chat.search.loading')} className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}
      {debouncedQuery && (
        <>
          <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
            {matches.length > 0
              ? t('chat.search.position', { current: matchIndex + 1, total: matches.length })
              : t('chat.search.noMatches')}
          </span>
          <Button aria-label={t('chat.search.previous')} variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={prev} disabled={matches.length === 0}>
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button aria-label={t('chat.search.next')} variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={next} disabled={matches.length === 0}>
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button aria-label={t('chat.search.clear')} variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={clear}>
            <X className="h-4 w-4" />
          </Button>
        </>
      )}
      {onToggleOutline && (
        <Button
          type="button"
          variant={outlineOpen ? 'secondary' : 'outline'}
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
          aria-controls="conversation-outline"
          aria-expanded={outlineOpen}
          aria-label={t('chat.outline.toggle', { count: outlineCount })}
          onClick={onToggleOutline}
        >
          <ListTree className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">{t('chat.outline.title')}</span>
          <span className="font-tabular rounded-md bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
            {outlineCount}
          </span>
        </Button>
      )}
    </div>
  );
}
