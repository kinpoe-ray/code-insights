import { cn } from '@/lib/utils';
import { INSIGHT_TYPE_MESSAGE_KEYS } from '@/lib/constants/colors';
import type { InsightType } from '@/lib/types';
import { useLocale } from '@/i18n/LocaleProvider';

const INSIGHT_TYPES: InsightType[] = ['summary', 'decision', 'learning', 'technique', 'prompt_quality'];

interface InsightTypePillsProps {
  /** Currently active types. Empty array = all types shown. */
  activeTypes: InsightType[];
  onChange: (types: InsightType[]) => void;
}

/**
 * Multi-select toggleable pills for insight type filtering.
 * All active = no filter (same as "all").
 * All inactive = treated as all (prevents zero-result dead-end).
 */
export function InsightTypePills({ activeTypes, onChange }: InsightTypePillsProps) {
  const { t } = useLocale();
  const allActive = activeTypes.length === 0 || activeTypes.length === INSIGHT_TYPES.length;

  function toggle(type: InsightType) {
    if (allActive) {
      // Start fresh: select only this type
      onChange([type]);
      return;
    }
    if (activeTypes.includes(type)) {
      const next = activeTypes.filter((t) => t !== type);
      // If removing last one, reset to all
      onChange(next.length === 0 ? [] : next);
    } else {
      const next = [...activeTypes, type];
      // If all are now selected, reset to empty (= all)
      onChange(next.length === INSIGHT_TYPES.length ? [] : next);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('insights.filterByType')}>
      {INSIGHT_TYPES.map((type) => {
        const isActive = allActive || activeTypes.includes(type);
        return (
          <button
            key={type}
            onClick={() => toggle(type)}
            aria-pressed={isActive}
            className={cn(
              'h-7 px-2.5 text-xs rounded-full cursor-pointer transition-colors border',
              isActive
                ? 'bg-primary/10 text-primary border-primary/20'
                : 'bg-transparent text-muted-foreground border-border hover:border-primary/30 hover:text-foreground'
            )}
          >
            {t(INSIGHT_TYPE_MESSAGE_KEYS[type])}
          </button>
        );
      })}
    </div>
  );
}
