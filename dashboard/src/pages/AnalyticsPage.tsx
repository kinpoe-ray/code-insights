import { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { BarChart3, Brain, FolderOpen, WalletCards } from 'lucide-react';
import { useAnalyticsOverview } from '@/hooks/useAnalytics';
import { ActivityChart } from '@/components/charts/ActivityChart';
import { InsightTypeChart } from '@/components/charts/InsightTypeChart';
import { DataTrustStrip } from '@/components/analytics/DataTrustStrip';
import { PageHeader, PageShell } from '@/components/layout/PageShell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ErrorCard';
import { formatModelName } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CHART_COLORS } from '@/lib/constants/colors';
import { SourceToolSelect } from '@/components/filters/SourceToolSelect';
import { useThemeColors } from '@/lib/hooks/useThemeColors';
import { useLocale } from '@/i18n/LocaleProvider';
import type { AnalyticsProject, AnalyticsRange } from '@/lib/types';
import type { MessageKey } from '@/i18n/messages/catalog';
import { ContextualOnboarding } from '@/components/onboarding/ProductOnboarding';

const rangeOptions: AnalyticsRange[] = ['7d', '30d', '90d', 'all'];
const rangeLabelKeys: Record<AnalyticsRange, MessageKey> = {
  '7d': 'analytics.range.7d',
  '30d': 'analytics.range.30d',
  '90d': 'analytics.range.90d',
  all: 'analytics.range.all',
};

function compactProjectPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

function buildProjectLabels(projects: AnalyticsProject[]) {
  const nameCounts = new Map<string, number>();
  for (const project of projects) {
    nameCounts.set(project.project_name, (nameCounts.get(project.project_name) ?? 0) + 1);
  }
  return new Map(projects.map((project) => [
    project.project_id,
    (nameCounts.get(project.project_name) ?? 0) > 1
      ? `${project.project_name} · ${compactProjectPath(project.project_path)}`
      : project.project_name,
  ]));
}

interface SummaryMetricProps {
  label: string;
  value: string;
  detail: string;
  icon: React.ElementType;
  detailTone?: 'default' | 'caution';
}

function SummaryMetric({ label, value, detail, icon: Icon, detailTone = 'default' }: SummaryMetricProps) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
            <p className="font-tabular mt-2 text-3xl font-semibold tracking-[-0.04em]">{value}</p>
          </div>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/9 text-primary">
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </div>
        </div>
        <p className={`mt-3 truncate text-xs ${detailTone === 'caution' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`} title={detail}>
          {detail}
        </p>
      </CardContent>
    </Card>
  );
}

function AnalyticsLoading() {
  const { t } = useLocale();
  return (
    <PageShell className="space-y-7">
      <PageHeader title={t('analytics.title')} subtitle={t('analytics.subtitle')} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[...Array(4)].map((_, index) => (
          <Card key={index}>
            <CardContent className="p-5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-4 h-9 w-20" />
              <Skeleton className="mt-4 h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-[390px] w-full rounded-2xl" />
    </PageShell>
  );
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const [source, setSource] = useState<string>('all');
  const { data, isLoading, isError, refetch } = useAnalyticsOverview(range, source);
  const { tooltipBg, tooltipBorder } = useThemeColors();
  const { t, formatDate, formatNumber } = useLocale();

  const projectLabels = useMemo(
    () => buildProjectLabels(data?.projects ?? []),
    [data?.projects],
  );
  const projectChartData = useMemo(
    () => (data?.projects ?? []).slice(0, 8).map((project) => ({
      name: projectLabels.get(project.project_id) ?? project.project_name,
      sessions: project.session_count,
    })),
    [data?.projects, projectLabels],
  );

  if (isLoading) return <AnalyticsLoading />;

  if (isError || !data) {
    return (
      <PageShell className="space-y-7">
        <PageHeader title={t('analytics.title')} subtitle={t('analytics.subtitle')} />
        <ErrorCard message={t('analytics.loadError')} onRetry={() => { void refetch(); }} />
      </PageShell>
    );
  }

  const totalSessions = data.summary.session_count;
  const totalTokens = data.summary.total_input_tokens
    + data.summary.total_output_tokens
    + data.summary.cache_creation_tokens
    + data.summary.cache_read_tokens;
  const usageCoverageIncomplete = data.coverage.usage_covered_sessions < totalSessions;
  const modelCoverage = data.coverage.model_covered_sessions;
  const unknownModels = Math.max(0, totalSessions - modelCoverage);
  const rangeStart = data.window_start
    ? formatDate(data.window_start, { month: 'short', day: 'numeric', year: range === 'all' ? 'numeric' : undefined })
    : t('analytics.range.all');
  const rangeEnd = formatDate(data.window_end, { month: 'short', day: 'numeric', year: range === 'all' ? 'numeric' : undefined });

  return (
    <PageShell className="space-y-7">
      <PageHeader
        eyebrow={t(rangeLabelKeys[range])}
        title={t('analytics.title')}
        subtitle={t('analytics.subtitle')}
        meta={(
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{t(data.activity_grain === 'month' ? 'analytics.windowMonthly' : 'analytics.window', { start: rangeStart, end: rangeEnd })}</span>
            <span aria-hidden="true">·</span>
            <span>{t('analytics.generatedNow', {
              time: formatDate(data.generated_at, { hour: '2-digit', minute: '2-digit' }),
            })}</span>
          </div>
        )}
        actions={(
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
            <div className="flex rounded-xl bg-muted/75 p-0.5">
              {rangeOptions.map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  className={`h-8 flex-1 rounded-[10px] px-3 text-xs sm:flex-none ${range === value ? 'bg-card text-foreground shadow-[0_1px_3px_hsl(240_10%_4%/0.10)] hover:bg-card' : 'text-muted-foreground'}`}
                  onClick={() => setRange(value)}
                  aria-pressed={range === value}
                >
                  {value === 'all' ? t('analytics.all') : value}
                </Button>
              ))}
            </div>
            <SourceToolSelect
              value={source}
              onValueChange={setSource}
              className="h-8 w-full rounded-[10px] bg-card text-xs sm:w-[160px]"
            />
          </div>
        )}
      />

      <ContextualOnboarding module="analytics" onAction={() => setRange('30d')} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={t('analytics.title')}>
        <SummaryMetric
          label={t('analytics.totalSessions')}
          value={formatNumber(totalSessions)}
          detail={t('analytics.sessionsDetail', {
            messages: formatNumber(data.summary.total_messages),
            tools: formatNumber(data.summary.total_tool_calls),
          })}
          icon={BarChart3}
        />
        <SummaryMetric
          label={t('analytics.totalInsights')}
          value={formatNumber(data.summary.insight_count)}
          detail={t('analytics.insightsDetail', {
            covered: data.coverage.analyzed_sessions,
            total: totalSessions,
          })}
          icon={Brain}
        />
        <SummaryMetric
          label={t('analytics.activeProjects')}
          value={formatNumber(data.summary.active_projects)}
          detail={t('analytics.projectsDetail')}
          icon={FolderOpen}
        />
        <SummaryMetric
          label={t(data.coverage.usage_covered_sessions > 0 ? 'analytics.estimatedCost' : 'analytics.totalTokens')}
          value={data.coverage.usage_covered_sessions > 0
            ? `$${data.summary.estimated_cost_usd.toFixed(2)}`
            : totalTokens > 0
              ? formatNumber(totalTokens, { notation: 'compact', maximumFractionDigits: 1 })
              : '—'}
          detail={data.coverage.usage_covered_sessions > 0
            ? t('analytics.costCoverageDetail', {
                covered: data.coverage.usage_covered_sessions,
                total: totalSessions,
              })
            : t('analytics.tokensDetail', {
                tokens: formatNumber(totalTokens, { notation: 'compact', maximumFractionDigits: 1 }),
              })}
          detailTone={usageCoverageIncomplete ? 'caution' : 'default'}
          icon={WalletCards}
        />
      </section>

      <DataTrustStrip
        totalSessions={totalSessions}
        analyzedSessions={data.coverage.analyzed_sessions}
        usageCoveredSessions={data.coverage.usage_covered_sessions}
        latestSyncAt={data.coverage.latest_sync_at}
        latestAnalysisAt={data.coverage.latest_analysis_at}
      />

      <ActivityChart data={data.daily} grain={data.activity_grain} />

      <section className="grid gap-6 lg:grid-cols-2">
        <InsightTypeChart data={data.insight_types} />

        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">{t('analytics.topProjects')}</CardTitle>
            <p className="text-xs text-muted-foreground">{t('analytics.projectsDetail')}</p>
          </CardHeader>
          <CardContent>
            <div className="h-[260px]" role="img" aria-label={t('analytics.topProjects')}>
              {projectChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={260} minWidth={0}>
                  <BarChart data={projectChartData} layout="vertical" accessibilityLayer margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid horizontal={false} strokeDasharray="2 4" className="stroke-border/55" />
                    <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} axisLine={false} tickLine={false} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tick={{ fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={150}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: tooltipBg,
                        borderColor: tooltipBorder,
                        borderRadius: '12px',
                        fontSize: '12px',
                        boxShadow: '0 12px 32px rgba(0,0,0,0.12)',
                      }}
                      cursor={{ fill: 'hsl(var(--muted) / 0.45)' }}
                    />
                    <Bar
                      dataKey="sessions"
                      fill={CHART_COLORS.projects.sessions}
                      name={t('analytics.sessions')}
                      radius={[0, 6, 6, 0]}
                      maxBarSize={22}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t('analytics.noProjectData')}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">{t('analytics.modelDistribution')}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t('analytics.sessionsWithModelData', { covered: modelCoverage, total: totalSessions })} · {t('analytics.modelShare')}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.models.map(({ model, session_count: count }, index) => {
            const share = modelCoverage > 0 ? Math.round((count / modelCoverage) * 100) : 0;
            return (
              <div key={model} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: CHART_COLORS.models[index % CHART_COLORS.models.length] }} />
                  <span className="truncate text-sm font-medium">{formatModelName(model)}</span>
                </div>
                <div className="font-tabular flex items-center gap-3 text-sm">
                  <span>{formatNumber(count)}</span>
                  <span className="w-10 text-right text-xs text-muted-foreground">{share}%</span>
                </div>
                <div className="col-span-2 ml-5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${share}%`, backgroundColor: CHART_COLORS.models[index % CHART_COLORS.models.length] }} />
                </div>
              </div>
            );
          })}
          {unknownModels > 0 && (
            <div className="flex items-center justify-between border-t border-border/60 pt-4 text-sm text-muted-foreground">
              <span>{t('analytics.unknownModel')}</span>
              <span className="font-tabular">{formatNumber(unknownModels)}</span>
            </div>
          )}
          {data.models.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('analytics.unknownModel')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">{t('analytics.allProjects')}</CardTitle>
          <p className="text-xs text-muted-foreground">{t('analytics.projectsDetail')}</p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border/70 text-xs text-muted-foreground">
                  <th className="py-3 pr-4 text-left font-medium">{t('analytics.project')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('analytics.sessions')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('analytics.insightCountShort')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('analytics.usageCoverageShort')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('analytics.estimatedCostShort')}</th>
                  <th className="py-3 pl-3 text-right font-medium">{t('analytics.totalTokens')}</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((project) => {
                  const tokens = project.total_input_tokens + project.total_output_tokens + project.cache_creation_tokens + project.cache_read_tokens;
                  const insightCount = project.summary_count + project.decision_count + project.learning_count + project.prompt_quality_count;
                  return (
                    <tr key={project.project_id} className="border-b border-border/55 last:border-0 hover:bg-muted/35">
                      <td className="py-3.5 pr-4">
                        <div className="font-medium">{projectLabels.get(project.project_id) ?? project.project_name}</div>
                        <div className="mt-0.5 max-w-[360px] truncate text-xs text-muted-foreground" title={project.project_path}>
                          {compactProjectPath(project.project_path)}
                        </div>
                      </td>
                      <td className="font-tabular px-3 py-3.5 text-right">{formatNumber(project.session_count)}</td>
                      <td className="font-tabular px-3 py-3.5 text-right">{formatNumber(insightCount)}</td>
                      <td className="font-tabular px-3 py-3.5 text-right text-muted-foreground">
                        {project.usage_covered_sessions}/{project.session_count}
                      </td>
                      <td className="font-tabular px-3 py-3.5 text-right">
                        {project.usage_covered_sessions > 0 ? `$${project.estimated_cost_usd.toFixed(2)}` : '—'}
                      </td>
                      <td className="font-tabular py-3.5 pl-3 text-right">
                        {tokens > 0 ? formatNumber(tokens, { notation: 'compact', maximumFractionDigits: 1 }) : '—'}
                      </td>
                    </tr>
                  );
                })}
                {data.projects.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      {t('analytics.emptyProjects')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
