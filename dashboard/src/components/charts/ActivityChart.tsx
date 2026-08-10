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
import type { DailyStats } from '@/lib/types';
import { useThemeColors } from '@/lib/hooks/useThemeColors';
import { CHART_COLORS } from '@/lib/constants/colors';
import { useLocale } from '@/i18n/LocaleProvider';

interface ActivityChartProps {
  data: DailyStats[];
  grain?: 'day' | 'month';
}

export function ActivityChart({ data, grain = 'day' }: ActivityChartProps) {
  const { tooltipBg, tooltipBorder } = useThemeColors();
  const { t, formatDate, formatNumber } = useLocale();

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        date: formatDate(d.date, {
          month: 'short',
          ...(grain === 'day' ? { day: 'numeric' as const } : { year: 'numeric' as const }),
          timeZone: 'UTC',
        }),
        // Normalize snake_case fields for recharts dataKey
        sessionCount: d.session_count,
        insightCount: d.insight_count,
      })),
    [data, formatDate, grain]
  );

  const series = [
    {
      dataKey: 'sessionCount' as const,
      label: t('analytics.sessions'),
      color: CHART_COLORS.activity.sessions,
      total: chartData.reduce((sum, point) => sum + point.sessionCount, 0),
    },
    {
      dataKey: 'insightCount' as const,
      label: t('analytics.insights'),
      color: CHART_COLORS.activity.insights,
      total: chartData.reduce((sum, point) => sum + point.insightCount, 0),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-[15px]">{t('analytics.activityOverTime')}</CardTitle>
        <p className="text-xs leading-5 text-muted-foreground">
          {t(grain === 'month' ? 'analytics.activityDescriptionMonthly' : 'analytics.activityDescription')}
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {series.map((item) => (
          <section key={item.dataKey} aria-label={item.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 px-1">
              <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                {item.label}
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {formatNumber(item.total)}
              </span>
            </div>
            <div
              className="h-[148px]"
              role="img"
              aria-label={`${item.label}. ${t('analytics.activityAccessibleSummary', { points: chartData.length })}`}
            >
              <ResponsiveContainer width="100%" height={148} minWidth={0}>
                <AreaChart
                  data={chartData}
                  accessibilityLayer
                  syncId="analytics-activity"
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="2 4" className="stroke-border/55" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    className="text-muted-foreground"
                    tickMargin={10}
                    padding={{ left: 8, right: 8 }}
                  />
                  <YAxis
                    width={44}
                    tick={{ fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    className="text-muted-foreground"
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
                    dataKey={item.dataKey}
                    name={item.label}
                    stroke={item.color}
                    fill={item.color}
                    fillOpacity={0.14}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
