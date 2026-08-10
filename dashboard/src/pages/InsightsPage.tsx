import { useMemo, useState, useCallback, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useInsightSearch } from '@/hooks/useInsights';
import { useSessions } from '@/hooks/useSessions';
import { useFilterParams } from '@/hooks/useFilterParams';
import { useProjects } from '@/hooks/useProjects';
import { useDispatchDiscovery } from '@/hooks/useDispatchDiscovery';
import { buildPatternGroups } from '@/lib/pattern-grouping';
import { buildDispatchPrefill } from '@/lib/buildDispatchPrefill';
import { InsightListItem } from '@/components/insights/InsightListItem';
// PromptQualityCard still used in SessionDetailPanel; on this page prompt_quality
// insights render inline via InsightListItem → PromptQualityContent.
import { RecurringPatternsSection } from '@/components/insights/RecurringPatternsSection';
import { InsightCardSkeleton } from '@/components/skeletons/InsightCardSkeleton';
import { ErrorCard } from '@/components/ErrorCard';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sparkles, SearchX, X, FileText, GitCommit, BookOpen, Target } from 'lucide-react';
import { getDateGroup, sortDateGroups } from '@/lib/utils';
import { INSIGHT_TYPE_MESSAGE_KEYS } from '@/lib/constants/colors';
import { parseJsonField } from '@/lib/types';
import type { Insight, InsightType, DispatchPrefill, SessionCharacter, EffectivePattern, FrictionPoint } from '@/lib/types';
import { InsightTypePills } from '@/components/filters/InsightTypePills';
import { SaveFilterPopover } from '@/components/filters/SaveFilterPopover';
import { SavedFiltersDropdown } from '@/components/filters/SavedFiltersDropdown';
import { SourceToolSelect } from '@/components/filters/SourceToolSelect';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { LlmNudgeBanner } from '@/components/LlmNudgeBanner';
import { DispatchDrawer } from '@/components/dispatch/DispatchDrawer';
import { FloatingActionBar } from '@/components/dispatch/FloatingActionBar';
import { DispatchEntryButton } from '@/components/insights/DispatchEntryButton';
import { DispatchDiscoveryCallout } from '@/components/insights/DispatchDiscoveryCallout';
import { fetchFacets } from '@/lib/api';
import { captureDispatchCalloutShown, captureDispatchOpenedFromInsights } from '@/lib/telemetry';
import { useLocale } from '@/i18n/LocaleProvider';
import { buildProjectLabels } from '@/lib/project-labels';
import { ContextualOnboarding } from '@/components/onboarding/ProductOnboarding';

const INSIGHT_TYPES: InsightType[] = ['summary', 'decision', 'learning', 'technique', 'prompt_quality'];

const QUALIFYING_SESSION_TYPES = new Set<SessionCharacter>(['feature_build', 'deep_focus', 'bug_hunt', 'refactor']);

const TYPE_SECTION_ICONS: Record<string, { icon: typeof FileText; color: string }> = {
  summary: { icon: FileText, color: 'text-purple-500' },
  decision: { icon: GitCommit, color: 'text-blue-500' },
  learning: { icon: BookOpen, color: 'text-green-500' },
  technique: { icon: BookOpen, color: 'text-green-500' },
  prompt_quality: { icon: Target, color: 'text-rose-500' },
};

const VIEW_MODES = [
  { value: 'timeline', labelKey: 'insights.view.timeline' },
  { value: 'type', labelKey: 'insights.view.type' },
  { value: 'project', labelKey: 'insights.view.project' },
  { value: 'session', labelKey: 'insights.view.session' },
] as const;

interface InsightGroup {
  key: string;
  label: string;
  count: number;
  insights: Insight[];
}

const MAX_DISPATCH_INSIGHTS = 8;

export default function InsightsPage() {
  const { t, formatDate, formatNumber } = useLocale();
  const [filters, setFilter, setFilters, clearFilters] = useFilterParams({
    q: '',
    project: 'all',
    type: 'all',
    view: 'timeline',
    pattern: '',
    source: 'all',
  });

  // Dispatch selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedInsights, setSelectedInsights] = useState<Insight[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dispatchPrefill, setDispatchPrefill] = useState<DispatchPrefill | undefined>(undefined);

  // Dispatch discovery: callout + opened tracking
  const { shouldShowCallout, markCalloutDismissed, markDispatchOpened } = useDispatchDiscovery();

  const handleToggleSelect = useCallback((insight: Insight) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(insight.id)) {
        next.delete(insight.id);
        setSelectedInsights((ins) => ins.filter((i) => i.id !== insight.id));
      } else {
        if (next.size >= MAX_DISPATCH_INSIGHTS) return prev;
        next.add(insight.id);
        setSelectedInsights((ins) => [...ins, insight]);
      }
      return next;
    });
  }, []);

  const handleReorder = useCallback((reordered: Insight[]) => {
    setSelectedInsights(reordered);
    setSelectedIds(new Set(reordered.map((i) => i.id)));
  }, []);

  const handleRemoveFromDrawer = useCallback((id: string) => {
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setSelectedInsights((ins) => ins.filter((i) => i.id !== id));
  }, []);

  const { savedFilters, saveFilter, deleteFilter } = useSavedFilters('insights');

  // activeTypes is a comma-separated list, or empty = all
  const activeTypes: InsightType[] = useMemo(() => {
    if (!filters.type || filters.type === 'all') return [];
    const parsed = filters.type
      .split(',')
      .filter((type) => INSIGHT_TYPES.includes(type as InsightType)) as InsightType[];
    if (parsed.includes('learning') || parsed.includes('technique')) {
      return [...new Set([
        ...parsed.filter((type) => type !== 'learning' && type !== 'technique'),
        'learning' as const,
        'technique' as const,
      ])];
    }
    return parsed;
  }, [filters.type]);

  function handleTypePillChange(types: InsightType[]) {
    setFilter('type', types.length === 0 ? 'all' : types.join(','));
  }

  const handleOnboardingAction = useCallback(() => {
    setFilters({ type: 'learning,technique', view: 'type' });
  }, [setFilters]);

  const [searchParams] = useSearchParams();
  const highlightedInsightId = searchParams.get('insight') || null;

  const { data: projects = [] } = useProjects();
  const projectLabels = useMemo(() => buildProjectLabels(projects), [projects]);
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(filters.q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const insightSearchParams = useMemo(() => ({
    ...(filters.project !== 'all' ? { projectId: filters.project } : {}),
    ...(activeTypes.length > 0 ? { type: activeTypes.join(',') } : {}),
    ...(filters.source !== 'all' ? { sourceTool: filters.source } : {}),
    ...(debouncedQuery ? { q: debouncedQuery } : {}),
  }), [activeTypes, debouncedQuery, filters.project, filters.source]);

  const {
    data: insightPages,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInsightSearch(insightSearchParams);
  const insights = useMemo(
    () => insightPages?.pages.flatMap((page) => page.insights) ?? [],
    [insightPages],
  );
  const totalInsights = insightPages?.pages[0]?.total ?? 0;

  // Sessions remain a small supporting index for the optional write-up flow.
  const { data: allSessions = [] } = useSessions({ limit: 500 });

  // Fetch raw facets to power DispatchEntryButton prefill
  const { data: facetsData } = useQuery({
    queryKey: ['facets', 'list'],
    queryFn: () => fetchFacets({ period: '30d' }),
    staleTime: 60_000,
  });

  // Build a map of session_id → facet row for prefill lookup
  const facetsBySessionId = useMemo(() => {
    const map = new Map<string, NonNullable<typeof facetsData>['facets'][0]>();
    for (const f of (facetsData?.facets ?? [])) {
      map.set(f.session_id, f);
    }
    return map;
  }, [facetsData]);

  // Primary qualifying session: most recent session with a qualifying character that has facets,
  // at least 3 insights (so canGenerate can be satisfied after auto-select), and non-empty
  // prefill content (so contextMarkdown won't be empty when the drawer opens).
  const primarySession = useMemo(() => {
    const qualifying = allSessions.filter((s) => {
      if (!s.session_character || !QUALIFYING_SESSION_TYPES.has(s.session_character as SessionCharacter)) return false;
      const facetRow = facetsBySessionId.get(s.id);
      if (!facetRow) return false;
      // Require ≥3 insights so canGenerate can be satisfied after auto-select
      const sessionInsightCount = insights.filter((i) => i.session_id === s.id).length;
      if (sessionInsightCount < 3) return false;
      // Require non-empty prefill content so contextMarkdown isn't empty
      const patterns = parseJsonField<EffectivePattern[]>(facetRow.effective_patterns, []);
      const friction = parseJsonField<FrictionPoint[]>(facetRow.friction_points, []).filter(
        (f) => f.attribution === 'user-actionable'
      );
      return patterns.length > 0 || friction.length > 0;
    });
    if (qualifying.length === 0) return null;
    return qualifying.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];
  }, [allSessions, facetsBySessionId, insights]);

  const allInsightIds = useMemo(() => new Set(insights.map((i) => i.id)), [insights]);

  // Fire callout_shown telemetry once when callout becomes visible
  useEffect(() => {
    if (shouldShowCallout && primarySession) {
      captureDispatchCalloutShown();
    }
  }, [shouldShowCallout, primarySession]);

  function openDispatchWithPrefill() {
    if (!primarySession) return;
    const facetRow = facetsBySessionId.get(primarySession.id);
    if (!facetRow) return;
    const prefill = buildDispatchPrefill(primarySession, facetRow);

    // Auto-select insights from this session so canGenerate passes on entry
    const sessionInsights = insights
      .filter((i) => i.session_id === primarySession.id)
      .slice(0, MAX_DISPATCH_INSIGHTS);
    setSelectedInsights(sessionInsights);
    setSelectedIds(new Set(sessionInsights.map((i) => i.id)));

    setDispatchPrefill(prefill);
    setDrawerOpen(true);
    markDispatchOpened();
    captureDispatchOpenedFromInsights();
  }

  function handleCalloutDismiss() {
    markCalloutDismissed();
  }

  const patternGroups = useMemo(() => buildPatternGroups(insights), [insights]);

  const patternInsightIds = useMemo(() => {
    if (!filters.pattern) return null;
    return patternGroups.get(filters.pattern) ?? null;
  }, [filters.pattern, patternGroups]);

  const filtered = useMemo(() => {
    return insights.filter((i) => {
      if (patternInsightIds && !patternInsightIds.has(i.id)) return false;
      return true;
    });
  }, [insights, patternInsightIds]);

  const hasFilters = !!filters.q || filters.type !== 'all' || filters.project !== 'all' || !!filters.pattern || filters.source !== 'all';

  const grouped = useMemo((): InsightGroup[] => {
    const view = filters.view;
    const groups = new Map<string, Insight[]>();

    for (const insight of filtered) {
      let key: string;
      if (view === 'type') {
        key = insight.type === 'technique' ? 'learning' : insight.type;
      } else if (view === 'project') {
        key = insight.project_id;
      } else if (view === 'session') {
        key = insight.session_id;
      } else {
        key = getDateGroup(insight.created_at);
      }
      const arr = groups.get(key) || [];
      arr.push(insight);
      groups.set(key, arr);
    }

    const entries = [...groups.entries()];

    if (view === 'timeline') {
      const sorted = sortDateGroups(entries);
      return sorted.map(([key, items]) => ({
        key,
        label: key === 'Today'
          ? t('insights.today')
          : key === 'Yesterday'
            ? t('insights.yesterday')
            : formatDate(items[0].created_at, {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
                ...(new Date(items[0].created_at).getFullYear() !== new Date().getFullYear()
                  ? { year: 'numeric' as const }
                  : {}),
              }),
        count: items.length,
        insights: items,
      }));
    }

    if (view === 'type') {
      return entries.map(([key, items]) => ({
        key,
        label: INSIGHT_TYPE_MESSAGE_KEYS[key as InsightType]
          ? t(INSIGHT_TYPE_MESSAGE_KEYS[key as InsightType])
          : key,
        count: items.length,
        insights: items,
      }));
    }

    if (view === 'project') {
      entries.sort((a, b) => b[1].length - a[1].length);
      return entries.map(([key, items]) => ({
        key,
        label: projectLabels.get(key) ?? items[0].project_name,
        count: items.length,
        insights: items,
      }));
    }

    // session view
    entries.sort((a, b) => {
      const aTime = Math.max(...a[1].map((i) => new Date(i.created_at).getTime()));
      const bTime = Math.max(...b[1].map((i) => new Date(i.created_at).getTime()));
      return bTime - aTime;
    });
    return entries.map(([key, items]) => {
      const first = items[0];
      const sessionDate = formatDate(first.created_at, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      return {
        key,
        label: `${first.project_name} -- ${sessionDate}`,
        count: items.length,
        insights: items,
      };
    });
  }, [filtered, filters.view, formatDate, projectLabels, t]);

  return (
    <div className="relative flex h-[calc(100dvh-4rem)] flex-col">
      {/* Sticky header: title + filters */}
      <div className="z-10 shrink-0 space-y-3 border-b bg-canvas/95 px-4 pb-3 pt-5 backdrop-blur-xl lg:px-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t('insights.title')}</h1>
            {!isLoading && (
              <p className="text-muted-foreground text-sm">
                {t('insights.count', {
                  count: totalInsights,
                  displayCount: formatNumber(totalInsights),
                  filtered: hasFilters ? 1 : 0,
                })}
                {insights.length < totalInsights && (
                  <span className="ml-2 text-xs">
                    {t('insights.loadedProgress', {
                      loaded: formatNumber(insights.length),
                      total: formatNumber(totalInsights),
                    })}
                  </span>
                )}
              </p>
            )}
          </div>
          <DispatchEntryButton
            sessionCharacter={primarySession?.session_character}
            facetsLoaded={!!primarySession && facetsBySessionId.has(primarySession.id)}
            onClick={openDispatchWithPrefill}
          />
        </div>

        {/* Pattern filter banner */}
        {filters.pattern && (
          <div className="flex items-center gap-2 rounded-lg border bg-amber-500/5 border-amber-500/20 px-3 py-2">
            <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 border-amber-500/20">
              {t('insights.pattern')}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {t('insights.patternShowing', { count: filtered.length })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 ml-auto shrink-0"
              onClick={() => setFilter('pattern', '')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* Filters + View Mode */}
        <div className="flex flex-wrap items-center gap-3">
          <SavedFiltersDropdown
            savedFilters={savedFilters}
            onApply={(f) => setFilters(f as Parameters<typeof setFilters>[0])}
            onDelete={deleteFilter}
          />

          <Input
            placeholder={t('insights.search')}
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value)}
            className="max-w-xs"
          />

          <Select value={filters.project} onValueChange={(v) => setFilter('project', v)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder={t('insights.allProjects')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('insights.allProjects')}</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {projectLabels.get(p.id) ?? p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <SourceToolSelect
            value={filters.source}
            onValueChange={(v) => setFilter('source', v)}
            className="w-[140px]"
          />

          <Tabs
            value={filters.view}
            onValueChange={(v) => setFilter('view', v)}
            className="ml-auto"
          >
            <TabsList variant="default" className="h-9">
              {VIEW_MODES.map((mode) => (
                <TabsTrigger key={mode.value} value={mode.value} className="text-xs px-3">
                  {t(mode.labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* Type pills row */}
        <div className="flex flex-wrap items-center gap-2">
          <InsightTypePills activeTypes={activeTypes} onChange={handleTypePillChange} />
          <SaveFilterPopover
            activeFilters={{ q: filters.q, project: filters.project, type: filters.type, source: filters.source }}
            defaultFilterValues={{ q: '', project: 'all', type: 'all', source: 'all' }}
            onSave={saveFilter}
          />
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 lg:px-8">
        <ContextualOnboarding module="insights" onAction={handleOnboardingAction} />
        {shouldShowCallout && primarySession && facetsBySessionId.has(primarySession.id) && (
          <DispatchDiscoveryCallout
            onTryIt={() => { openDispatchWithPrefill(); }}
            onDismiss={handleCalloutDismiss}
          />
        )}
        <LlmNudgeBanner context="insights" />
        {isError && !isLoading ? (
        <ErrorCard message={t('insights.failed')} onRetry={refetch} />
      ) : isLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <InsightCardSkeleton key={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        hasFilters ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
            <SearchX className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">{t('insights.noMatches')}</p>
            <p className="text-sm text-muted-foreground">
              {t('insights.noMatchesHint')}
            </p>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              {t('insights.clearFilters')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
            <Sparkles className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">{t('insights.empty')}</p>
            <p className="text-sm text-muted-foreground max-w-sm">
              {t('insights.emptyDescription')}
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings">{t('insights.configureProvider')}</Link>
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-6">
          {!filters.pattern && insights.length > 0 && (
            <RecurringPatternsSection
              insights={insights}
              partial={insights.length < totalInsights}
            />
          )}

          {grouped.map((group) => {
            const sectionMeta = filters.view === 'type' ? TYPE_SECTION_ICONS[group.key] : null;
            const SectionIcon = sectionMeta?.icon;

            return (
              <div key={group.key}>
                <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {SectionIcon && <SectionIcon className={`h-3.5 w-3.5 ${sectionMeta.color}`} />}
                  {group.label} ({group.count})
                </h2>
                <div className="overflow-hidden rounded-2xl border border-border/80 bg-elevated shadow-sm">
                  {group.insights.map((insight) => {
                    const isSelected = selectedIds.has(insight.id);
                    const atMax = selectedIds.size >= MAX_DISPATCH_INSIGHTS;
                    return (
                      <div
                        key={insight.id}
                        className={`relative group/dispatch ${isSelected ? 'bg-primary/5' : ''}`}
                      >
                        <div
                          className={`absolute left-2 top-3 z-10 transition-opacity ${
                            isSelected
                              ? 'opacity-100'
                              : 'opacity-0 group-hover/dispatch:opacity-100 group-focus-within/dispatch:opacity-100'
                          }`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={isSelected}
                            disabled={!isSelected && atMax}
                            onCheckedChange={() => handleToggleSelect(insight)}
                            aria-label={t('insights.select', { title: insight.title })}
                          />
                        </div>
                        <div className={`transition-[padding-left] ${isSelected ? 'pl-8' : 'group-hover/dispatch:pl-8 group-focus-within/dispatch:pl-8'}`}>
                          <InsightListItem
                            insight={insight}
                            showProject={filters.view !== 'project'}
                            allInsightIds={allInsightIds}
                            highlighted={insight.id === highlightedInsightId}
                            defaultExpanded={insight.id === highlightedInsightId}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {hasNextPage && !filters.pattern && (
            <div className="flex flex-col items-center gap-2 py-4">
              <p className="text-xs text-muted-foreground">
                {t('insights.loadedProgress', {
                  loaded: formatNumber(insights.length),
                  total: formatNumber(totalInsights),
                })}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={isFetchingNextPage}
                onClick={() => fetchNextPage()}
              >
                {isFetchingNextPage ? t('insights.loadingMore') : t('insights.loadMore')}
              </Button>
            </div>
          )}
        </div>
        )}
      </div>

      <FloatingActionBar
        count={selectedIds.size}
        onOpen={() => { setDispatchPrefill(undefined); setDrawerOpen(true); }}
      />

      <DispatchDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        selectedInsights={selectedInsights}
        onReorder={handleReorder}
        onRemove={handleRemoveFromDrawer}
        prefill={dispatchPrefill}
      />
    </div>
  );
}
