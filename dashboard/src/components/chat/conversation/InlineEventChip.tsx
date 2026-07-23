import { Terminal } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';

interface InlineEventChipProps {
  command: string; // e.g., "/compact", "/plan", "/review"
  timestamp: string; // ISO 8601
}

/**
 * Centered inline chip for user-initiated slash commands.
 * Lightweight — no background or border — just icon + monospace command + timestamp.
 * Used for /compact (user-initiated) and all other slash commands.
 */
export function InlineEventChip({ command, timestamp }: InlineEventChipProps) {
  const { t, formatDate } = useLocale();
  const formattedTime = formatDate(timestamp, { hour: 'numeric', minute: '2-digit' });

  return (
    <div
      aria-label={t('chat.slashCommand.aria', { command, time: formattedTime })}
      className="flex justify-center items-center gap-1.5 py-1.5 px-4"
    >
      <Terminal className="h-3 w-3 text-muted-foreground" />
      <span className="text-xs font-mono text-muted-foreground transition-colors hover:text-foreground">
        {command}
      </span>
      <span className="text-xs text-muted-foreground ml-1">{formattedTime}</span>
    </div>
  );
}
