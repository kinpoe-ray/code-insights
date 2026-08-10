import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useThemeColors } from '@/lib/hooks/useThemeColors';
import { CHART_COLORS } from '@/lib/constants/colors';
import { useLocale } from '@/i18n/LocaleProvider';
import type { DailyStats } from '@/lib/types';

type DashboardRange = '7d' | '30d' | '90d' | 'all';

interface DashboardActivityChartProps {
  data: DailyStats[];
  range: DashboardRange;
  onRangeChange: (range: DashboardRange) => void;
}

const rangeOptions = [
  { value: '7d', labelKey: 'dashboard.chart.range.7d' },
  { value: '30d', labelKey: 'dashboard.chart.range.30d' },
  { value: '90d', labelKey: 'dashboard.chart.range.90d' },
  { value: 'all', labelKey: 'dashboard.chart.range.all' },
] as const satisfies ReadonlyArray<{ value: DashboardRange; labelKey: string }>;

export function DashboardActivityChart({ data, range, onRangeChange }: DashboardActivityChartProps) {
  const { tooltipBg, tooltipBorder } = useThemeColors();
  const { t, formatDate } = useLocale();

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        date: formatDate(new Date(d.date), {
          month: 'short',
          day: 'numeric',
        }),
        // Normalize field names to match recharts dataKey
        sessionCount: d.session_count,
        insightCount: d.insight_count,
      })),
    [data, formatDate]
  );

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-[15px] font-semibold">{t('dashboard.chart.activity')}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t('dashboard.chart.description')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground" aria-label={t('dashboard.chart.legend')}>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CHART_COLORS.activity.sessions }} />
              {t('dashboard.chart.sessions')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: CHART_COLORS.activity.insights }} />
              {t('dashboard.chart.insights')}
            </span>
          </div>
        </div>
        <div className="flex self-start rounded-[10px] bg-muted/75 p-0.5">
          {rangeOptions.map(({ value, labelKey }) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              className={`h-7 rounded-lg px-2.5 text-xs ${range === value ? 'bg-card text-foreground shadow-[0_1px_3px_hsl(240_10%_4%/0.10)] hover:bg-card' : 'text-muted-foreground'}`}
              onClick={() => onRangeChange(value)}
              aria-pressed={range === value}
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div
          className="h-[230px]"
          role="img"
          aria-label={t('dashboard.chart.accessibleSummary', { points: chartData.length })}
        >
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={230} minWidth={0}>
              <AreaChart data={chartData} accessibilityLayer margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="dashColorSessions" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.activity.sessions} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_COLORS.activity.sessions} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="dashColorInsights" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.activity.insights} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_COLORS.activity.insights} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="2 4" className="stroke-border/55" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  className="text-muted-foreground"
                  tickMargin={10}
                  padding={{ left: 8, right: 8 }}
                  interval={range === '7d' ? 0 : range === '30d' ? 4 : range === '90d' ? 13 : 'preserveStartEnd'}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  className="text-muted-foreground"
                  width={30}
                  allowDecimals={false}
                  tickMargin={8}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: tooltipBg,
                    borderColor: tooltipBorder,
                    borderRadius: '12px',
                    fontSize: '12px',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.12)',
                  }}
                  cursor={{ stroke: tooltipBorder, strokeDasharray: '3 3' }}
                />
                <Area
                  type="linear"
                  dataKey="sessionCount"
                  name={t('dashboard.chart.sessions')}
                  stroke={CHART_COLORS.activity.sessions}
                  fillOpacity={1}
                  fill="url(#dashColorSessions)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2 }}
                />
                <Area
                  type="linear"
                  dataKey="insightCount"
                  name={t('dashboard.chart.insights')}
                  stroke={CHART_COLORS.activity.insights}
                  fillOpacity={1}
                  fill="url(#dashColorInsights)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">{t('dashboard.chart.noData')}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
