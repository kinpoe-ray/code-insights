import { PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';

interface FloatingActionBarProps {
  count: number;
  onOpen: () => void;
}

const MAX_INSIGHTS = 8;

export function FloatingActionBar({ count, onOpen }: FloatingActionBarProps) {
  const { t } = useLocale();

  if (count < 3) return null;

  const atMax = count >= MAX_INSIGHTS;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-full border bg-background shadow-lg px-4 py-2.5 animate-in slide-in-from-bottom-4 duration-300">
      <span className="text-sm font-medium">
        {t('dispatch.selectionCount', { count })}
      </span>
      {atMax && (
        <span className="text-xs text-amber-600 dark:text-amber-400">
          {t('dispatch.maxReached')}
        </span>
      )}
      <Button size="sm" className="h-8 gap-1.5 rounded-full" onClick={onOpen}>
        <PenLine className="h-3.5 w-3.5" />
        {t('dispatch.createPost')}
      </Button>
    </div>
  );
}
