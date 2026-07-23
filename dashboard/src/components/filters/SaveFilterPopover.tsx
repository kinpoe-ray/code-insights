import { useState } from 'react';
import { Bookmark } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from 'sonner';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';

type Translate = ReturnType<typeof useLocale>['t'];

const FILTER_FIELD_KEYS: Record<string, MessageKey> = {
  q: 'sessions.filters.field.search',
  project: 'sessions.filters.field.project',
  source: 'sessions.filters.field.source',
  character: 'sessions.filters.field.character',
  status: 'sessions.filters.field.status',
  dateRange: 'sessions.filters.field.dateRange',
  dateFrom: 'sessions.filters.field.dateFrom',
  dateTo: 'sessions.filters.field.dateTo',
  outcome: 'sessions.filters.field.outcome',
};

const FILTER_VALUE_KEYS: Record<string, MessageKey> = {
  deep_focus: 'sessions.character.deepFocus',
  bug_hunt: 'sessions.character.bugHunt',
  feature_build: 'sessions.character.featureBuild',
  exploration: 'sessions.character.exploration',
  refactor: 'sessions.character.refactor',
  learning: 'sessions.character.learning',
  quick_task: 'sessions.character.quickTask',
  analyzed: 'sessions.filters.analyzed',
  unanalyzed: 'sessions.filters.notAnalyzed',
  '7d': 'sessions.filters.last7Days',
  '30d': 'sessions.filters.last30Days',
  '90d': 'sessions.filters.last90Days',
  custom: 'sessions.filters.custom',
  success: 'sessions.filters.outcomeSuccess',
  partial: 'sessions.filters.outcomePartial',
  blocked: 'sessions.filters.outcomeBlocked',
  abandoned: 'sessions.filters.outcomeAbandoned',
};

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  'codex-cli': 'Codex CLI',
  'copilot-cli': 'Copilot CLI',
  copilot: 'Copilot',
};

export function sessionFilterFieldLabel(key: string, t: Translate): string {
  return FILTER_FIELD_KEYS[key] ? t(FILTER_FIELD_KEYS[key]) : key.replace(/_/g, ' ');
}

export function sessionFilterValueLabel(key: string, value: string, t: Translate): string {
  if (value === 'all') {
    if (key === 'source') return t('sessions.filters.allSources');
    if (key === 'character') return t('sessions.filters.allTypes');
    if (key === 'status') return t('sessions.filters.allStatus');
    if (key === 'outcome') return t('sessions.filters.allOutcomes');
    if (key === 'dateRange') return t('sessions.filters.allTime');
  }
  if (key === 'source' && SOURCE_LABELS[value]) return SOURCE_LABELS[value];
  return FILTER_VALUE_KEYS[value] ? t(FILTER_VALUE_KEYS[value]) : value.replace(/_/g, ' ');
}

interface SaveFilterPopoverProps {
  activeFilters: Record<string, string>;
  defaultFilterValues: Record<string, string>;
  onSave: (name: string, filters: Record<string, string>) => void;
}

/** Generate a human-readable name from active filter values. */
function generateName(
  activeFilters: Record<string, string>,
  defaults: Record<string, string>,
  fallback: string,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(activeFilters)) {
    if (value !== defaults[key] && value && value !== 'all') {
      // Prettify key names
      const label = key === 'q' ? value : value.replace(/_/g, ' ');
      parts.push(label);
    }
  }
  return parts.slice(0, 3).join(' / ') || fallback;
}

/**
 * "Save" button that opens a popover to name and save the current filters.
 * Only visible when at least one non-default filter is active.
 */
export function SaveFilterPopover({ activeFilters, defaultFilterValues, onSave }: SaveFilterPopoverProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  // Determine which filters are non-default
  const nonDefaultFilters: Record<string, string> = {};
  for (const [key, value] of Object.entries(activeFilters)) {
    if (value !== defaultFilterValues[key] && value && value !== 'all' && key !== 'session') {
      nonDefaultFilters[key] = value;
    }
  }

  const hasNonDefault = Object.keys(nonDefaultFilters).length > 0;

  if (!hasNonDefault) return null;

  function handleOpen(nextOpen: boolean) {
    if (nextOpen) {
      setName(generateName(activeFilters, defaultFilterValues, t('sessions.filters.defaultName')));
    }
    setOpen(nextOpen);
  }

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed, nonDefaultFilters);
    setOpen(false);
    toast.success(t('sessions.filters.savedToast'));
  }

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5 shrink-0">
          <Bookmark className="h-3.5 w-3.5" />
          {t('sessions.filters.save')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4" align="end">
        <div className="space-y-3">
          <div className="text-sm font-medium">{t('sessions.filters.saveCurrent')}</div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t('sessions.filters.name')}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              className="h-8 text-sm"
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{t('sessions.filters.filters')}</div>
            <div className="space-y-0.5">
              {Object.entries(nonDefaultFilters).map(([key, value]) => (
                <div key={key} className="text-xs text-muted-foreground/80">
                  <span>{sessionFilterFieldLabel(key, t)}</span>:{' '}
                  <span className="text-foreground">{sessionFilterValueLabel(key, value, t)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
              {t('sessions.filters.cancel')}
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={!name.trim()}>
              {t('sessions.filters.save')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
