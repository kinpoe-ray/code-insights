import { Bookmark, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SavedFilter } from '@/hooks/useSavedFilters';
import { useLocale } from '@/i18n/LocaleProvider';
import { sessionFilterFieldLabel, sessionFilterValueLabel } from './SaveFilterPopover';

interface SavedFiltersDropdownProps {
  savedFilters: SavedFilter[];
  onApply: (filters: Record<string, string>) => void;
  onDelete: (id: string) => void;
}

/**
 * Dropdown listing saved filter presets.
 * Click a row to apply all filters from that preset.
 * Trash icon deletes the preset (no confirmation — low-cost action).
 */
export function SavedFiltersDropdown({
  savedFilters,
  onApply,
  onDelete,
}: SavedFiltersDropdownProps) {
  const { t } = useLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 shrink-0">
          <Bookmark className="h-3.5 w-3.5" />
          {t('sessions.filters.saved')}
          <ChevronDown className="h-3 w-3 ml-0.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1">
        {savedFilters.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            <p className="font-medium">{t('sessions.filters.noneSaved')}</p>
            <p className="mt-0.5">{t('sessions.filters.noneSavedHint')}</p>
          </div>
        ) : (
          savedFilters.map((sf) => {
            const subtitle = Object.entries(sf.filters)
              .map(([k, v]) => `${sessionFilterFieldLabel(k, t)}: ${sessionFilterValueLabel(k, v, t)}`)
              .join(', ');

            return (
              <div
                key={sf.id}
                className="flex items-start gap-2 px-3 py-2 rounded hover:bg-accent cursor-pointer group transition-colors"
                onClick={() => onApply(sf.filters)}
              >
                <Bookmark className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{sf.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{subtitle}</div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(sf.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5 text-muted-foreground hover:text-destructive"
                  aria-label={t('sessions.filters.deleteSaved')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
