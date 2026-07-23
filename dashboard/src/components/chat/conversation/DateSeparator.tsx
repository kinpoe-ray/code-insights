import { useLocale } from '@/i18n/LocaleProvider';

interface DateSeparatorProps {
  timestamp: string;  // ISO 8601 string
}

export function DateSeparator({ timestamp }: DateSeparatorProps) {
  const { formatDate } = useLocale();
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex-1 border-t border-border" />
      <span className="text-xs text-muted-foreground shrink-0">
        {formatDate(timestamp, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </span>
      <div className="flex-1 border-t border-border" />
    </div>
  );
}
