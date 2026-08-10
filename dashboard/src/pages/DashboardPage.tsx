import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Database, Sparkles } from 'lucide-react';
import { useAnalyticsOverview } from '@/hooks/useAnalytics';
import { useSessions } from '@/hooks/useSessions';
import { useInsights } from '@/hooks/useInsights';
import { StatsHero } from '@/components/dashboard/StatsHero';
import { DashboardActivityChart } from '@/components/dashboard/DashboardActivityChart';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { BulkAnalyzeButton } from '@/components/analysis/BulkAnalyzeButton';
import { StatsHeroSkeleton } from '@/components/skeletons/StatsHeroSkeleton';
import { ErrorCard } from '@/components/ErrorCard';
import { PageHeader, PageShell } from '@/components/layout/PageShell';
import { DashboardOnboardingChecklist } from '@/components/onboarding/ProductOnboarding';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/i18n/LocaleProvider';
import { parseStoredTimestamp } from '@/lib/date-utils';
import type { AnalyticsRange } from '@/lib/types';

function getGreetingKey() {
  const hour = new Date().getHours();
  if (hour < 12) return 'dashboard.greeting.morning' as const;
  if (hour < 17) return 'dashboard.greeting.afternoon' as const;
  return 'dashboard.greeting.evening' as const;
}

function percent(covered: number, total: number) {
  return total > 0 ? Math.round((covered / total) * 100) : 0;
}

export default function DashboardPage() {
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const { t, formatDate, formatRelativeDate } = useLocale();

  const {
    data: overview,
    isLoading: overviewLoading,
    isError: overviewError,
    refetch: refetchOverview,
  } = useAnalyticsOverview(range);
  const {
    data: sessions = [],
    isLoading: sessionsLoading,
    isError: sessionsError,
    refetch: refetchSessions,
  } = useSessions({ limit: 10 });
  const {
    data: insights = [],
    isLoading: insightsLoading,
  } = useInsights({ limit: 12 });

  const feedLoading = sessionsLoading || insightsLoading;
  const todayLabel = formatDate(new Date(), { month: 'long', day: 'numeric' });
  const latestSync = overview?.coverage.latest_sync_at
    ? parseStoredTimestamp(overview.coverage.latest_sync_at)
    : null;
  const analysisCoverage = overview
    ? percent(overview.coverage.analyzed_sessions, overview.summary.session_count)
    : 0;
  const usageCoverage = overview
    ? percent(overview.coverage.usage_covered_sessions, overview.summary.session_count)
    : 0;
  const totalTokens = overview
    ? overview.summary.total_input_tokens
      + overview.summary.total_output_tokens
      + overview.summary.cache_creation_tokens
      + overview.summary.cache_read_tokens
    : 0;

  return (
    <PageShell className="space-y-6">
      <PageHeader
        eyebrow={todayLabel}
        title={t(getGreetingKey())}
        subtitle={overview
          ? t('dashboard.scopeSummary', {
              sessions: overview.summary.session_count,
              insights: overview.summary.insight_count,
              projects: overview.summary.active_projects,
            })
          : t('dashboard.subtitle')}
        meta={overview ? (
          <Link
            to="/analytics"
            className="inline-flex flex-wrap items-center gap-2 rounded-full bg-muted/75 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/35"
          >
            <Database className="h-3.5 w-3.5 text-primary" />
            <span>{t('dashboard.coverageSummary', { analysis: analysisCoverage, usage: usageCoverage })}</span>
            {latestSync && (
              <>
                <span aria-hidden="true">·</span>
                <span>{t('dashboard.lastSync', { time: formatRelativeDate(latestSync) })}</span>
              </>
            )}
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : undefined}
      />

      <DashboardOnboardingChecklist />

      {overviewError && !overviewLoading && (
        <ErrorCard
          message={t('dashboard.error.load')}
          onRetry={() => { void refetchOverview(); }}
        />
      )}

      {overviewLoading || !overview ? (
        <StatsHeroSkeleton />
      ) : (
        <StatsHero
          totalSessions={overview.summary.session_count}
          totalMessages={overview.summary.total_messages}
          totalToolCalls={overview.summary.total_tool_calls}
          totalDurationMin={overview.summary.total_duration_min}
          totalProjects={overview.summary.active_projects}
          isExact
          totalTokens={totalTokens}
          totalCost={overview.summary.estimated_cost_usd}
          usageCoverage={{
            covered: overview.coverage.usage_covered_sessions,
            total: overview.summary.session_count,
          }}
          tokenBreakdown={{
            inputTokens: overview.summary.total_input_tokens,
            outputTokens: overview.summary.total_output_tokens,
            cacheCreationTokens: overview.summary.cache_creation_tokens,
            cacheReadTokens: overview.summary.cache_read_tokens,
          }}
        />
      )}

      {overviewLoading || !overview ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-2 h-3 w-56" />
            </div>
            <Skeleton className="h-8 w-40 rounded-xl" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[230px] w-full rounded-xl" />
          </CardContent>
        </Card>
      ) : (
        <DashboardActivityChart data={overview.daily} range={range} onRangeChange={setRange} />
      )}

      {overview && overview.unanalyzed_session_ids.length > 0 && (
        <Card className="overflow-hidden border-amber-500/25 bg-amber-500/[0.045]">
          <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-amber-500/12 text-amber-700 dark:text-amber-300">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold">
                  {t('dashboard.unanalyzed.count', { sessions: overview.unanalyzed_session_ids.length })}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t('dashboard.unanalyzed.description')}
                </p>
              </div>
            </div>
            <BulkAnalyzeButton sessionIds={overview.unanalyzed_session_ids} onComplete={() => { void refetchOverview(); }} />
          </CardContent>
        </Card>
      )}

      <section>
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em]">{t('dashboard.recentActivity')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('dashboard.recentActivityDescription')}</p>
          </div>
          <Link
            to="/sessions"
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-75"
          >
            {t('dashboard.viewAll')}
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        <Card>
          <CardContent className="px-4 py-2 sm:px-5">
            {sessionsError && !feedLoading ? (
              <ErrorCard
                message={t('dashboard.error.load')}
                onRetry={() => { void refetchSessions(); }}
              />
            ) : feedLoading ? (
              <div className="divide-y divide-border/55">
                {[...Array(5)].map((_, index) => (
                  <div key={index} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Skeleton className="h-8 w-8 shrink-0 rounded-[10px]" />
                      <div>
                        <Skeleton className="h-4 w-56 max-w-full" />
                        <Skeleton className="mt-2 h-3 w-28" />
                      </div>
                    </div>
                    <Skeleton className="h-3 w-14 shrink-0" />
                  </div>
                ))}
              </div>
            ) : (
              <ActivityFeed sessions={sessions} insights={insights} limit={7} />
            )}
          </CardContent>
        </Card>
      </section>
    </PageShell>
  );
}
