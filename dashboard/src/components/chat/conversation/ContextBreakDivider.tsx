import { Scissors } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';

interface ContextBreakDividerProps {
  timestamp: string; // ISO 8601
}

/**
 * Full-width amber dashed divider rendered when auto-compaction occurs.
 * Signals a context window overflow — the AI's context was reset mid-session.
 * Amber matches the existing "attention" palette used by task notifications.
 */
export function ContextBreakDivider({ timestamp }: ContextBreakDividerProps) {
  const { t, formatDate } = useLocale();
  const formattedTime = formatDate(timestamp, { hour: 'numeric', minute: '2-digit' });

  return (
    <div
      role="separator"
      aria-label={t('chat.compaction.aria', { time: formattedTime })}
      className="flex items-center gap-3 px-4 py-3 my-2 border-y border-amber-500/20 bg-amber-500/5 transition-colors hover:bg-amber-500/10"
    >
      <div className="flex-1 border-t border-dashed border-amber-500/30" />
      <div className="flex flex-col items-center gap-0.5 shrink-0">
        <div className="flex items-center gap-1.5">
          <Scissors className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-sm font-medium text-foreground">{t('chat.compaction.title')}</span>
        </div>
        <span className="text-xs text-muted-foreground">{t('chat.compaction.subtitle')}</span>
      </div>
      <div className="flex-1 border-t border-dashed border-amber-500/30" />
      <span className="text-xs text-muted-foreground shrink-0">{formattedTime}</span>
    </div>
  );
}
