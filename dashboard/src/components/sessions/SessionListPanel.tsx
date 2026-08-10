import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { CompactSessionRow } from './CompactSessionRow';
import {
  SessionOnboardingCoach,
  SessionOnboardingWelcome,
  SessionReviewPresetBar,
  getReviewPresetCounts,
  matchesReviewPreset,
  type ReviewPreset,
} from './SessionOnboarding';
import type { Session, SessionListSignal, Project } from '@/lib/types';
import type { SessionOnboardingStep } from '@/hooks/useSessionOnboarding';
import { cn } from '@/lib/utils';
import { SearchX, Terminal, EyeOff, CalendarDays, Search, SlidersHorizontal } from 'lucide-react';
import { useDeletedSessionCount } from '@/hooks/useSessions';
import { useQueuedSessionIds } from '@/hooks/useAnalysisQueue';
import { SaveFilterPopover } from '@/components/filters/SaveFilterPopover';
import { SavedFiltersDropdown } from '@/components/filters/SavedFiltersDropdown';
import { SourceToolSelect } from '@/components/filters/SourceToolSelect';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { subDays, startOfDay, formatISO } from 'date-fns';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';
import { buildProjectLabels } from '@/lib/project-labels';

const SESSION_CHARACTERS = [
  'deep_focus',
  'bug_hunt',
  'feature_build',
  'exploration',
  'refactor',
  'learning',
  'quick_task',
] as const;

const DATE_PRESETS = [
  { labelKey: 'sessions.filters.last7Days', value: '7d' },
  { labelKey: 'sessions.filters.last30Days', value: '30d' },
  { labelKey: 'sessions.filters.last90Days', value: '90d' },
  { labelKey: 'sessions.filters.allTime', value: 'all' },
  { labelKey: 'sessions.filters.customRangeOption', value: 'custom' },
] as const;

const OUTCOME_OPTIONS = [
  { labelKey: 'sessions.filters.allOutcomes', value: 'all' },
  { labelKey: 'sessions.filters.outcomeSuccess', value: 'success', color: 'text-emerald-600' },
  { labelKey: 'sessions.filters.outcomePartial', value: 'partial', color: 'text-amber-600' },
  { labelKey: 'sessions.filters.outcomeBlocked', value: 'blocked', color: 'text-red-600' },
  { labelKey: 'sessions.filters.outcomeAbandoned', value: 'abandoned', color: 'text-red-600' },
] as const;

const CHARACTER_LABEL_KEYS: Record<(typeof SESSION_CHARACTERS)[number], MessageKey> = {
  deep_focus: 'sessions.character.deepFocus',
  bug_hunt: 'sessions.character.bugHunt',
  feature_build: 'sessions.character.featureBuild',
  exploration: 'sessions.character.exploration',
  refactor: 'sessions.character.refactor',
  learning: 'sessions.character.learning',
  quick_task: 'sessions.character.quickTask',
};

function localDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface SessionListPanelProps {
  sessions: Session[];
  signals: SessionListSignal[];
  projects: Project[];
  selectedSessionId: string;
  selectedProject: string;
  showProject: boolean;
  projectId?: string;
  filters: {
    q: string;
    character: string;
    status: string;
    dateRange: string;
    dateFrom: string;
    dateTo: string;
    outcome: string;
    source: string;
  };
  onFilterChange: (
    key: 'q' | 'character' | 'status' | 'dateRange' | 'dateFrom' | 'dateTo' | 'outcome' | 'source',
    value: string
  ) => void;
  onSetFilters: (updates: Record<string, string>) => void;
  onClearFilters: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  loading: boolean;
  missingFacetIds?: Set<string>;
  totalSessions: number;
  hasMore: boolean;
  onLoadMore: () => void;
  reviewPreset: ReviewPreset;
  onReviewPresetChange: (value: ReviewPreset) => void;
  onboardingStep: SessionOnboardingStep;
  onboardingTargetSessionId?: string;
  showOnboardingWelcome: boolean;
  onStartOnboarding: () => void;
  onHideOnboardingWelcome: () => void;
  onDismissOnboarding: () => void;
}

export function SessionListPanel({
  sessions,
  signals,
  projects,
  selectedSessionId,
  selectedProject,
  showProject,
  projectId,
  filters,
  onFilterChange,
  onSetFilters,
  onClearFilters,
  onSelectProject,
  onSelectSession,
  loading,
  missingFacetIds,
  totalSessions,
  hasMore,
  onLoadMore,
  reviewPreset,
  onReviewPresetChange,
  onboardingStep,
  onboardingTargetSessionId,
  showOnboardingWelcome,
  onStartOnboarding,
  onHideOnboardingWelcome,
  onDismissOnboarding,
}: SessionListPanelProps) {
  const { t, formatDate, formatNumber } = useLocale();
  const [customDateOpen, setCustomDateOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const { savedFilters, saveFilter, deleteFilter } = useSavedFilters('sessions');
  const projectLabels = useMemo(() => buildProjectLabels(projects), [projects]);

  const { data: deletedCount = 0 } = useDeletedSessionCount(projectId);
  const queuedSessionIds = useQueuedSessionIds();
  const analyzedSessionIds = useMemo(
    () => new Set(signals.filter((signal) => signal.is_analyzed).map((signal) => signal.session_id)),
    [signals]
  );

  const insightCountsBySession = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    for (const signal of signals) {
      map.set(signal.session_id, signal.insight_counts);
    }
    return map;
  }, [signals]);

  const sessionOutcomes = useMemo(() => {
    const map = new Map<string, string>();
    for (const signal of signals) {
      if (signal.outcome) map.set(signal.session_id, signal.outcome);
    }
    return map;
  }, [signals]);

  const promptQualityScores = useMemo(() => {
    const map = new Map<string, number>();
    for (const signal of signals) {
      if (signal.prompt_quality_score !== null) {
        map.set(signal.session_id, signal.prompt_quality_score);
      }
    }
    return map;
  }, [signals]);

  const signalsBySession = useMemo(
    () => new Map(signals.map((signal) => [signal.session_id, signal])),
    [signals]
  );

  // Compute date range bounds for client-side filtering
  const dateBounds = useMemo(() => {
    if (filters.dateRange === 'all' || !filters.dateRange) return null;
    if (filters.dateRange === 'custom') {
      return { from: filters.dateFrom || null, to: filters.dateTo || null };
    }
    const days = parseInt(filters.dateRange.replace('d', ''), 10);
    if (isNaN(days)) return null;
    const from = formatISO(startOfDay(subDays(new Date(), days)));
    return { from, to: null };
  }, [filters.dateRange, filters.dateFrom, filters.dateTo]);

  const baseFilteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      if (filters.character !== 'all' && s.session_character !== filters.character) return false;
      if (filters.status === 'analyzed' && !analyzedSessionIds.has(s.id)) return false;
      if (filters.status === 'unanalyzed' && analyzedSessionIds.has(s.id)) return false;
      if (filters.q) {
        const q = filters.q.toLowerCase();
        const title = (s.custom_title || s.generated_title || s.summary || t('sessions.untitled')).toLowerCase();
        if (!title.includes(q) && !s.project_name.toLowerCase().includes(q)) return false;
      }
      if (dateBounds) {
        if (dateBounds.from && s.started_at < dateBounds.from) return false;
        if (dateBounds.to && s.started_at > dateBounds.to) return false;
      }
      if (filters.outcome && filters.outcome !== 'all') {
        const sessionOutcome = sessionOutcomes.get(s.id);
        // Unanalyzed sessions always pass the outcome filter
        if (sessionOutcome && sessionOutcome !== filters.outcome) return false;
      }
      return true;
    });
  }, [sessions, filters.character, filters.status, filters.q, analyzedSessionIds, dateBounds, filters.outcome, sessionOutcomes, t]);

  const reviewPresetCounts = useMemo(
    () => getReviewPresetCounts(baseFilteredSessions, signals),
    [baseFilteredSessions, signals]
  );

  const filteredSessions = useMemo(
    () => baseFilteredSessions.filter((session) =>
      matchesReviewPreset(signalsBySession.get(session.id), reviewPreset)
    ),
    [baseFilteredSessions, reviewPreset, signalsBySession]
  );

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const s of filteredSessions) {
      const group = localDateKey(s.started_at);
      const arr = groups.get(group) || [];
      arr.push(s);
      groups.set(group, arr);
    }
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const todayKey = localDateKey(now);
    const yesterdayKey = localDateKey(yesterday);

    return [...groups.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([groupKey, sessions]) => {
        let label: string;
        if (groupKey === todayKey) {
          label = t('sessions.date.today');
        } else if (groupKey === yesterdayKey) {
          label = t('sessions.date.yesterday');
        } else {
          const date = new Date(sessions[0].started_at);
          label = formatDate(date, {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
            ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
          });
        }
        return { groupKey, label, sessions };
      });
  }, [filteredSessions, formatDate, t]);

  const hasClientFilters =
    selectedProject !== 'all' ||
    filters.character !== 'all' ||
    filters.status !== 'all' ||
    !!filters.q ||
    (!!filters.dateRange && filters.dateRange !== 'all') ||
    (!!filters.outcome && filters.outcome !== 'all') ||
    filters.source !== 'all' ||
    reviewPreset !== 'all';

  const allFiltersForSave = { ...filters, project: selectedProject } as Record<string, string>;
  const defaultFilterValues: Record<string, string> = {
    q: '', project: 'all', character: 'all', status: 'all', dateRange: 'all', dateFrom: '', dateTo: '', outcome: 'all', source: 'all',
  };

  const dateRangeLabel = useMemo(() => {
    if (!filters.dateRange || filters.dateRange === 'all') return t('sessions.filters.allTime');
    if (filters.dateRange === 'custom') {
      if (filters.dateFrom && filters.dateTo) return `${filters.dateFrom} – ${filters.dateTo}`;
      if (filters.dateFrom) return t('sessions.filters.fromValue', { value: filters.dateFrom });
      if (filters.dateTo) return t('sessions.filters.toValue', { value: filters.dateTo });
      return t('sessions.filters.custom');
    }
    const preset = DATE_PRESETS.find((p) => p.value === filters.dateRange);
    return preset ? t(preset.labelKey) : filters.dateRange;
  }, [filters.dateRange, filters.dateFrom, filters.dateTo, t]);

  const focusOnboardingTarget = useCallback((node: HTMLDivElement | null) => {
    if (!node || onboardingStep !== 1) return;
    window.requestAnimationFrame(() => {
      const scroller = sessionListRef.current;
      if (!scroller || typeof scroller.scrollTo !== 'function') return;
      const targetRect = node.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      scroller.scrollTo({
        top: scroller.scrollTop + targetRect.top - scrollerRect.top,
        behavior: 'smooth',
      });
    });
  }, [onboardingStep, onboardingTargetSessionId]);

  return (
    <div className="flex flex-col h-full">
      {/* Session passport discovery controls */}
      <div className="shrink-0 p-4 space-y-3 border-b bg-background">
        <div className="flex items-center gap-2">
          <div className="flex shrink-0 items-baseline gap-1.5">
            <h1 className="text-lg font-semibold tracking-tight">{t('sessions.listTitle')}</h1>
            {!loading && (
              <span className="font-tabular text-[11px] text-muted-foreground">
                {formatNumber(totalSessions)}
              </span>
            )}
          </div>
          <div className="relative min-w-24 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('sessions.searchPlaceholder')}
              value={filters.q}
              onChange={(e) => onFilterChange('q', e.target.value)}
              className="h-9 pl-8 text-xs"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <SavedFiltersDropdown
              savedFilters={savedFilters}
              onApply={(f) => onSetFilters(f)}
              onDelete={deleteFilter}
            />
            <Popover open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className={cn(
                    'h-9 w-9',
                    (filters.status !== 'all' || filters.outcome !== 'all') && 'border-primary text-primary'
                  )}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span className="sr-only">{t('sessions.filters.more')}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 space-y-3 p-3">
                <div>
                  <div className="mb-1.5 text-xs font-medium">{t('sessions.filters.status')}</div>
                  <Select
                    value={filters.status}
                    onValueChange={(v) => onFilterChange('status', v)}
                  >
                    <SelectTrigger className="w-full text-xs">
                      <SelectValue placeholder={t('sessions.filters.status')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('sessions.filters.allStatus')}</SelectItem>
                      <SelectItem value="analyzed">{t('sessions.filters.analyzed')}</SelectItem>
                      <SelectItem value="unanalyzed">{t('sessions.filters.notAnalyzed')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-medium">{t('sessions.filters.outcome')}</div>
                  <Select
                    value={filters.outcome || 'all'}
                    onValueChange={(v) => onFilterChange('outcome', v)}
                  >
                    <SelectTrigger className="w-full text-xs">
                      <SelectValue placeholder={t('sessions.filters.outcome')} />
                    </SelectTrigger>
                    <SelectContent>
                      {OUTCOME_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value} className="text-xs">
                          {t(o.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </PopoverContent>
            </Popover>
            <SaveFilterPopover
              activeFilters={allFiltersForSave}
              defaultFilterValues={defaultFilterValues}
              onSave={saveFilter}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
          <FilterField label={t('sessions.filters.field.dateRange')}>
            <Popover open={customDateOpen} onOpenChange={setCustomDateOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-full justify-between gap-1 px-2 text-xs font-normal">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{dateRangeLabel}</span>
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-52 p-1">
                {DATE_PRESETS.map((preset) => {
                  if (preset.value === 'custom') {
                    return (
                      <div key="custom" className="border-t mt-1 pt-1">
                        <div className="text-xs text-muted-foreground px-2 py-1">{t('sessions.filters.customRange')}</div>
                        <div className="px-2 space-y-1.5 pb-1">
                          <Input
                            placeholder={t('sessions.filters.fromDate')}
                            value={filters.dateFrom}
                            onChange={(e) => {
                              onFilterChange('dateFrom', e.target.value);
                              onFilterChange('dateRange', 'custom');
                            }}
                            className="h-7 text-xs"
                          />
                          <Input
                            placeholder={t('sessions.filters.toDate')}
                            value={filters.dateTo}
                            onChange={(e) => {
                              onFilterChange('dateTo', e.target.value);
                              onFilterChange('dateRange', 'custom');
                            }}
                            className="h-7 text-xs"
                          />
                        </div>
                      </div>
                    );
                  }
                  const isActive = filters.dateRange === preset.value || (!filters.dateRange && preset.value === 'all');
                  return (
                    <button
                      key={preset.value}
                      onClick={() => {
                        onFilterChange('dateRange', preset.value);
                        onFilterChange('dateFrom', '');
                        onFilterChange('dateTo', '');
                        setCustomDateOpen(false);
                      }}
                      className={`w-full text-xs text-left px-3 py-1.5 rounded hover:bg-accent transition-colors ${
                        isActive ? 'font-medium text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {isActive ? '✓ ' : ''}{t(preset.labelKey)}
                    </button>
                  );
                })}
              </PopoverContent>
            </Popover>
          </FilterField>

          <FilterField label={t('sessions.filters.field.project')}>
          <Select
              value={selectedProject}
              onValueChange={onSelectProject}
          >
              <SelectTrigger className="h-7 w-full border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0">
                <SelectValue placeholder={t('sessions.allProjects')} />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all">{t('sessions.allProjects')}</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id} className="text-xs">
                    {projectLabels.get(project.id) ?? project.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          </FilterField>

          <FilterField label={t('sessions.filters.field.source')}>
          <SourceToolSelect
            value={filters.source || 'all'}
            onValueChange={(v) => onFilterChange('source', v)}
              className="h-7 w-full border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0"
          />
          </FilterField>

          <FilterField label={t('sessions.filters.mode')}>
            <Select
              value={filters.character}
              onValueChange={(v) => onFilterChange('character', v)}
            >
              <SelectTrigger className="h-7 w-full border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0">
                <SelectValue placeholder={t('sessions.filters.mode')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('sessions.filters.allModes')}</SelectItem>
                {SESSION_CHARACTERS.map((c) => (
                  <SelectItem key={c} value={c} className="capitalize text-xs">
                    {t(CHARACTER_LABEL_KEYS[c])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
        </div>
      </div>

      {showOnboardingWelcome && (
        <SessionOnboardingWelcome
          onStart={onStartOnboarding}
          onSkip={onDismissOnboarding}
          onClose={onHideOnboardingWelcome}
        />
      )}

      <SessionReviewPresetBar
        value={reviewPreset}
        counts={reviewPresetCounts}
        onValueChange={onReviewPresetChange}
        className={showOnboardingWelcome ? 'pt-2' : 'pt-3'}
      />

      {/* Session list */}
      <div ref={sessionListRef} className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="animate-pulse space-y-1.5 px-3 py-2.5">
                <div className="h-4 bg-muted rounded w-4/5" />
                <div className="h-3 bg-muted rounded w-2/5" />
                <div className="h-3 bg-muted rounded w-3/5" />
              </div>
            ))}
          </div>
        ) : filteredSessions.length === 0 ? (
          hasClientFilters ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4 space-y-2">
              <SearchX className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t('sessions.noMatching')}</p>
              <Button variant="outline" size="sm" onClick={onClearFilters}>
                {t('sessions.clearFilters')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4 space-y-2">
              <Terminal className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t('sessions.noSessionsYet')}</p>
              <p className="text-xs text-muted-foreground">
                {t('sessions.syncToStart')}
              </p>
            </div>
          )
        ) : (
          <div>
            {groupedSessions.map(({ groupKey, label, sessions: groupSessions }) => (
              <div key={groupKey}>
                <div className="px-3 pt-3 pb-1">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {label}
                  </h3>
                </div>
                {groupSessions.map((session) => {
                  const isOnboardingTarget =
                    onboardingStep === 1 && session.id === onboardingTargetSessionId;
                  return (
                    <div
                      key={session.id}
                      ref={isOnboardingTarget ? focusOnboardingTarget : undefined}
                      className={cn(
                        'relative',
                        isOnboardingTarget && 'z-20 rounded-lg ring-2 ring-inset ring-primary/20'
                      )}
                    >
                      <CompactSessionRow
                        session={session}
                        isActive={session.id === selectedSessionId}
                        showProject={showProject}
                        insightCounts={insightCountsBySession.get(session.id)}
                        outcome={sessionOutcomes.get(session.id)}
                        promptQualityScore={promptQualityScores.get(session.id)}
                        isAnalyzed={analyzedSessionIds.has(session.id)}
                        missingFacets={analyzedSessionIds.has(session.id) && (missingFacetIds?.has(session.id) ?? false)}
                        isQueued={queuedSessionIds.has(session.id)}
                        onClick={() => onSelectSession(session.id)}
                      />
                      {isOnboardingTarget && (
                        <SessionOnboardingCoach
                          step={1}
                          title={t('sessions.onboarding.step1Title')}
                          description={t('sessions.onboarding.step1Description')}
                          actionLabel={t('sessions.onboarding.step1Action')}
                          onAction={() => onSelectSession(session.id)}
                          onDismiss={onDismissOnboarding}
                          compactAction
                          className="right-2 top-[calc(100%-10px)]"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {hasMore && (
              <div className="flex flex-col items-center gap-2 border-t px-4 py-5">
                <p className="text-xs text-muted-foreground">
                  {t('sessions.resultProgress', {
                    loaded: formatNumber(sessions.length),
                    total: formatNumber(totalSessions),
                  })}
                </p>
                <Button type="button" variant="outline" size="sm" onClick={onLoadMore}>
                  {t('sessions.loadMore')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Hidden sessions footer — only shown when a project is selected and some sessions are hidden */}
      {projectId && deletedCount > 0 && (
        <div className="shrink-0 border-t px-3 py-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <EyeOff className="h-3 w-3 shrink-0" />
          <span>{t('sessions.hiddenCount', { count: deletedCount })}</span>
        </div>
      )}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/10 px-1.5 py-1">
      <div className="px-2 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
