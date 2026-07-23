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
      <CardHeader className="flex flex-row items-center justify-between pb-1">
        <CardTitle className="text-sm font-medium">{t('dashboard.chart.activity')}</CardTitle>
        <div className="flex gap-1">
          {rangeOptions.map(({ value, labelKey }) => (
            <Button
              key={value}
              variant={range === value ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => onRangeChange(value)}
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
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
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  className="text-muted-foreground"
                  interval={range === '7d' ? 0 : range === '30d' ? 4 : range === '90d' ? 13 : 'preserveStartEnd'}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  className="text-muted-foreground"
                  width={30}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: tooltipBg,
                    borderColor: tooltipBorder,
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="sessionCount"
                  name={t('dashboard.chart.sessions')}
                  stroke={CHART_COLORS.activity.sessions}
                  fillOpacity={1}
                  fill="url(#dashColorSessions)"
                />
                <Area
                  type="monotone"
                  dataKey="insightCount"
                  name={t('dashboard.chart.insights')}
                  stroke={CHART_COLORS.activity.insights}
                  fillOpacity={1}
                  fill="url(#dashColorInsights)"
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
