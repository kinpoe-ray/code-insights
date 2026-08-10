import { useMemo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useMissingFacets } from '@/hooks/useFacets';
import { useSessionIndex } from '@/hooks/useSessions';
import { useProjects } from '@/hooks/useProjects';
import { useFilterParams } from '@/hooks/useFilterParams';
import { SessionListPanel } from '@/components/sessions/SessionListPanel';
import { SessionDetailPanel } from '@/components/sessions/SessionDetailPanel';
import {
  matchesReviewPreset,
  type ReviewPreset,
} from '@/components/sessions/SessionOnboarding';
import { useSessionOnboarding } from '@/hooks/useSessionOnboarding';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ArrowLeft, MousePointerClick } from 'lucide-react';
import { useLocale } from '@/i18n/LocaleProvider';

const lgQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null;
function subscribeLg(cb: () => void) {
  lgQuery?.addEventListener('change', cb);
  return () => lgQuery?.removeEventListener('change', cb);
}
function getIsLg() {
  return lgQuery?.matches ?? true;
}

export default function SessionsPage() {
  const { t } = useLocale();
  const [filters, setFilter, setFilters, clearFilters] = useFilterParams({
    q: '',
    project: 'all',
    source: 'all',
    character: 'all',
    status: 'all',
    dateRange: 'all',
    dateFrom: '',
    dateTo: '',
    outcome: 'all',
    session: '',
  });

  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q);
  const [sessionLimit, setSessionLimit] = useState(200);
  const [reviewPreset, setReviewPreset] = useState<ReviewPreset>('all');
  const onboarding = useSessionOnboarding();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(filters.q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const dateQuery = useMemo(() => {
    if (filters.dateRange === 'custom') {
      const from = filters.dateFrom
        ? new Date(`${filters.dateFrom}T00:00:00`).toISOString()
        : undefined;
      const to = filters.dateTo
        ? new Date(`${filters.dateTo}T23:59:59.999`).toISOString()
        : undefined;
      return { from, to };
    }
    if (!filters.dateRange || filters.dateRange === 'all') return {};
    const days = Number.parseInt(filters.dateRange.replace('d', ''), 10);
    if (!Number.isFinite(days) || days < 1) return {};
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (days - 1));
    return { from: from.toISOString() };
  }, [filters.dateFrom, filters.dateRange, filters.dateTo]);

  useEffect(() => {
    setSessionLimit(200);
  }, [
    debouncedQuery,
    filters.character,
    filters.dateFrom,
    filters.dateRange,
    filters.dateTo,
    filters.outcome,
    filters.project,
    filters.source,
    filters.status,
  ]);

  const sessionParams = useMemo(() => {
    const params: {
      projectId?: string;
      sourceTool?: string;
      q?: string;
      character?: string;
      status?: string;
      outcome?: string;
      from?: string;
      to?: string;
      limit?: number;
    } = { limit: sessionLimit, ...dateQuery };
    if (filters.project !== 'all') params.projectId = filters.project;
    if (filters.source !== 'all') params.sourceTool = filters.source;
    if (debouncedQuery) params.q = debouncedQuery;
    if (filters.character !== 'all') params.character = filters.character;
    if (filters.status !== 'all') params.status = filters.status;
    if (filters.outcome !== 'all') params.outcome = filters.outcome;
    return params;
  }, [dateQuery, debouncedQuery, filters.character, filters.outcome, filters.project, filters.source, filters.status, sessionLimit]);

  const { data: sessionIndex, isLoading: sessionsLoading } = useSessionIndex(sessionParams);
  const sessions = sessionIndex?.sessions ?? [];
  const signals = sessionIndex?.signals ?? [];
  const totalSessions = sessionIndex?.total ?? sessions.length;
  const signalsBySession = useMemo(
    () => new Map(signals.map((signal) => [signal.session_id, signal])),
    [signals]
  );
  const onboardingTargetSessionId = useMemo(() => {
    const selectedSession = sessions.find((session) => session.id === filters.session);
    if (selectedSession) return selectedSession.id;
    return sessions.find((session) =>
      matchesReviewPreset(signalsBySession.get(session.id), 'needs-review')
    )?.id ?? sessions.find((session) => signalsBySession.get(session.id)?.is_analyzed)?.id
      ?? sessions[0]?.id;
  }, [filters.session, sessions, signalsBySession]);

  const { data: missingFacetsData } = useMissingFacets();
  const missingFacetIds = useMemo(
    () => new Set(missingFacetsData?.sessionIds ?? []),
    [missingFacetsData]
  );

  const loading = sessionsLoading || projectsLoading;

  const handleSelectProject = useCallback(
    (projectId: string) => {
      const currentSessionId = filters.session;
      if (currentSessionId && projectId !== 'all') {
        const currentSession = sessions.find((s) => s.id === currentSessionId);
        if (currentSession && currentSession.project_id !== projectId) {
          setFilters({ project: projectId, session: '' });
          return;
        }
      }
      setFilter('project', projectId);
    },
    [filters.session, sessions, setFilter, setFilters]
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setFilter('session', sessionId);
      if (onboarding.step === 1) onboarding.goToStep(2);
    },
    [onboarding, setFilter]
  );

  const handleReviewPresetChange = useCallback(
    (nextPreset: ReviewPreset) => {
      setReviewPreset(nextPreset);
      if (nextPreset === 'all') return;
      const firstMatch = sessions.find((session) =>
        matchesReviewPreset(signalsBySession.get(session.id), nextPreset)
      );
      if (firstMatch) setFilter('session', firstMatch.id);
    },
    [sessions, setFilter, signalsBySession]
  );

  const handleStartOnboarding = useCallback(() => {
    setReviewPreset('all');
    onboarding.start();
    if (onboardingTargetSessionId) setFilter('session', onboardingTargetSessionId);
  }, [onboarding, onboardingTargetSessionId, setFilter]);

  const handleFilterChange = useCallback(
    (key: 'q' | 'character' | 'status' | 'dateRange' | 'dateFrom' | 'dateTo' | 'outcome' | 'source', value: string) => {
      setFilter(key, value);
    },
    [setFilter]
  );

  const handleSetFilters = useCallback(
    (updates: Record<string, string>) => {
      setReviewPreset('all');
      setFilters(updates as Parameters<typeof setFilters>[0]);
    },
    [setFilters]
  );

  const handleClearFilters = useCallback(() => {
    setReviewPreset('all');
    setFilters({ q: '', character: 'all', status: 'all', dateRange: 'all', dateFrom: '', dateTo: '', outcome: 'all', source: 'all' });
  }, [setFilters]);

  const showProject = filters.project === 'all';
  const isLg = useSyncExternalStore(subscribeLg, getIsLg);

  // On desktop, the list and detail form one continuous workspace. Showing the
  // newest session immediately avoids a large dead panel and matches familiar
  // mail/file-browser behavior. Mobile keeps explicit selection to avoid opening
  // a sheet unexpectedly.
  useEffect(() => {
    if (isLg && !loading && !filters.session && sessions.length > 0) {
      setFilter('session', sessions[0].id);
    }
  }, [filters.session, isLg, loading, sessions, setFilter]);

  return (
    <div className="flex h-[calc(100dvh-4rem)]">
      {/* Session passport list — projects are a first-class filter, not a separate navigation wall. */}
      <div className="w-full shrink-0 bg-background lg:w-[400px] lg:border-r xl:w-[480px] 2xl:w-[520px] flex flex-col overflow-hidden">
        <SessionListPanel
          sessions={sessions}
          signals={signals}
          projects={projects}
          selectedSessionId={filters.session}
          selectedProject={filters.project}
          showProject={showProject}
          projectId={filters.project !== 'all' ? filters.project : undefined}
          filters={{
            q: filters.q,
            character: filters.character,
            status: filters.status,
            dateRange: filters.dateRange,
            dateFrom: filters.dateFrom,
            dateTo: filters.dateTo,
            outcome: filters.outcome,
            source: filters.source,
          }}
          onFilterChange={handleFilterChange}
          onSetFilters={handleSetFilters}
          onClearFilters={handleClearFilters}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
          loading={loading}
          missingFacetIds={missingFacetIds}
          totalSessions={totalSessions}
          hasMore={sessions.length < totalSessions}
          onLoadMore={() => setSessionLimit((current) => Math.min(current + 200, 5000))}
          reviewPreset={reviewPreset}
          onReviewPresetChange={handleReviewPresetChange}
          onboardingStep={onboarding.step}
          onboardingTargetSessionId={onboardingTargetSessionId}
          showOnboardingWelcome={onboarding.showWelcome}
          onStartOnboarding={handleStartOnboarding}
          onHideOnboardingWelcome={onboarding.hideWelcome}
          onDismissOnboarding={onboarding.dismiss}
        />
      </div>

      {/* Panel C: Session Detail — visible at lg+, Sheet at md, hidden below */}
      {isLg && (
        <div className="flex flex-1 min-w-0 bg-background overflow-hidden">
          {filters.session ? (
            <div className="flex-1 overflow-y-auto" key={filters.session}>
              <SessionDetailPanel
                sessionId={filters.session}
                onDelete={() => setFilter('session', '')}
                onboardingStep={onboarding.step}
                onOnboardingStepChange={onboarding.goToStep}
                onDismissOnboarding={onboarding.dismiss}
                onCompleteOnboarding={onboarding.complete}
                onRestartOnboarding={handleStartOnboarding}
                showOnboardingReplay={onboarding.canReplay}
              />
            </div>
          ) : (
            <EmptyDetailState />
          )}
        </div>
      )}

      {/* Below lg: Session detail as Sheet from right */}
      {!isLg && filters.session && onboarding.step !== 1 && (
        <Sheet
          open={!!filters.session}
          onOpenChange={(open) => {
            if (!open) setFilter('session', '');
          }}
        >
          <SheetContent side="right" className="w-full sm:w-[85vw] p-0 flex flex-col">
            <SheetHeader className="sr-only">
              <SheetTitle>{t('sessions.detail.title')}</SheetTitle>
              <SheetDescription>{t('sessions.detail.viewDescription')}</SheetDescription>
            </SheetHeader>
            <div className="shrink-0 px-3 pt-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => setFilter('session', '')}
              >
                <ArrowLeft className="h-3 w-3" />
                {t('sessions.backToList')}
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <SessionDetailPanel
                sessionId={filters.session}
                onDelete={() => setFilter('session', '')}
                onboardingStep={onboarding.step}
                onOnboardingStepChange={onboarding.goToStep}
                onDismissOnboarding={onboarding.dismiss}
                onCompleteOnboarding={onboarding.complete}
                onRestartOnboarding={handleStartOnboarding}
                showOnboardingReplay={onboarding.canReplay}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function EmptyDetailState() {
  const { t } = useLocale();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
      <MousePointerClick className="h-10 w-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm font-medium text-muted-foreground">{t('sessions.selectSessionTitle')}</p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        {t('sessions.selectSessionDescription')}
      </p>
    </div>
  );
}
