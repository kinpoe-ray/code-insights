import { cn } from '@/lib/utils';
import { INSIGHT_TYPE_MESSAGE_KEYS } from '@/lib/constants/colors';
import type { InsightType } from '@/lib/types';
import { useLocale } from '@/i18n/LocaleProvider';

const TYPE_GROUPS: Array<{
  key: Exclude<InsightType, 'technique'>;
  types: InsightType[];
}> = [
  { key: 'summary', types: ['summary'] },
  { key: 'decision', types: ['decision'] },
  // `technique` is a legacy storage value for the same user-facing concept.
  // Keep both in the query while presenting one stable filter.
  { key: 'learning', types: ['learning', 'technique'] },
  { key: 'prompt_quality', types: ['prompt_quality'] },
];

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
  const activeGroups = new Set(
    TYPE_GROUPS
      .filter((group) => group.types.some((type) => activeTypes.includes(type)))
      .map((group) => group.key),
  );
  const allActive = activeTypes.length === 0 || activeGroups.size === TYPE_GROUPS.length;

  function toggle(key: Exclude<InsightType, 'technique'>) {
    const group = TYPE_GROUPS.find((candidate) => candidate.key === key)!;
    if (allActive) {
      onChange(group.types);
      return;
    }
    if (activeGroups.has(key)) {
      const next = activeTypes.filter((type) => !group.types.includes(type));
      // If removing last one, reset to all
      onChange(next.length === 0 ? [] : next);
    } else {
      const next = [...new Set([...activeTypes, ...group.types])];
      // If all are now selected, reset to empty (= all)
      const nextGroupCount = TYPE_GROUPS.filter((candidate) =>
        candidate.types.some((type) => next.includes(type)),
      ).length;
      onChange(nextGroupCount === TYPE_GROUPS.length ? [] : next);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('insights.filterByType')}>
      {TYPE_GROUPS.map(({ key }) => {
        const isActive = allActive || activeGroups.has(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => toggle(key)}
            aria-pressed={isActive}
            className={cn(
              'h-7 px-2.5 text-xs rounded-full cursor-pointer transition-colors border',
              isActive
                ? 'bg-primary/10 text-primary border-primary/20'
                : 'bg-transparent text-muted-foreground border-border hover:border-primary/30 hover:text-foreground'
            )}
          >
            {t(INSIGHT_TYPE_MESSAGE_KEYS[key])}
          </button>
        );
      })}
    </div>
  );
}
