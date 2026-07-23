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
}

export function ActivityChart({ data }: ActivityChartProps) {
  const { tooltipBg, tooltipBorder } = useThemeColors();
  const { t, formatDate } = useLocale();

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        date: formatDate(d.date, {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        }),
        // Normalize snake_case fields for recharts dataKey
        sessionCount: d.session_count,
        insightCount: d.insight_count,
      })),
    [data, formatDate]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('analytics.activityOverTime')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="colorSessions" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.activity.sessions} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.activity.sessions} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorInsights" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.activity.insights} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.activity.insights} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                className="text-muted-foreground"
              />
              <YAxis
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                className="text-muted-foreground"
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
                name={t('analytics.sessions')}
                stroke={CHART_COLORS.activity.sessions}
                fillOpacity={1}
                fill="url(#colorSessions)"
              />
              <Area
                type="monotone"
                dataKey="insightCount"
                name={t('analytics.insights')}
                stroke={CHART_COLORS.activity.insights}
                fillOpacity={1}
                fill="url(#colorInsights)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
