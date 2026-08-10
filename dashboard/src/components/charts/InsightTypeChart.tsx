import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useThemeColors } from '@/lib/hooks/useThemeColors';
import { CHART_COLORS } from '@/lib/constants/colors';
import { useLocale } from '@/i18n/LocaleProvider';

interface InsightTypeChartProps {
  data: {
    summary: number;
    decision: number;
    learning: number;
    prompt_quality: number;
  };
}

const COLORS = CHART_COLORS.insightTypes;

export function InsightTypeChart({ data }: InsightTypeChartProps) {
  const { tooltipBg, tooltipBorder } = useThemeColors();
  const { t } = useLocale();
  const labels = {
    summary: t('analytics.summaries'),
    decision: t('analytics.decisions'),
    learning: t('analytics.learnings'),
    prompt_quality: t('analytics.promptQuality'),
  };
  const chartData = Object.entries(data)
    .filter(([_, value]) => value > 0)
    .map(([name, value]) => ({
      name: labels[name as keyof typeof labels],
      value,
      color: COLORS[name as keyof typeof COLORS],
    }));
  const total = chartData.reduce((sum, item) => sum + item.value, 0);

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">{t('analytics.insightTypes')}</CardTitle>
          <p className="text-xs text-muted-foreground">{t('analytics.insightTypesDescription')}</p>
        </CardHeader>
        <CardContent>
          <div className="flex h-[200px] items-center justify-center">
            <p className="text-sm text-muted-foreground">{t('analytics.noInsights')}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">{t('analytics.insightTypes')}</CardTitle>
        <p className="text-xs text-muted-foreground">{t('analytics.insightTypesDescription')}</p>
      </CardHeader>
      <CardContent>
        <div className="grid items-center gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
          <div className="relative h-[220px]" role="img" aria-label={`${t('analytics.insightTypes')}: ${total}`}>
            <ResponsiveContainer width="100%" height={220} minWidth={0}>
              <PieChart accessibilityLayer>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={58}
                  outerRadius={84}
                  paddingAngle={2}
                  cornerRadius={4}
                  dataKey="value"
                  stroke="none"
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: tooltipBg,
                    borderColor: tooltipBorder,
                    borderRadius: '12px',
                    fontSize: '12px',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.12)',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-tabular text-2xl font-semibold tracking-[-0.04em]">{total}</span>
              <span className="mt-1 text-[11px] text-muted-foreground">{t('analytics.insights')}</span>
            </div>
          </div>
          <div className="space-y-3">
            {chartData.map((entry) => {
              const percent = total > 0 ? Math.round((entry.value / total) * 100) : 0;
              return (
                <div key={entry.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
                    <span className="truncate text-sm">{entry.name}</span>
                  </div>
                  <div className="font-tabular flex items-center gap-3 text-sm">
                    <span className="font-medium">{entry.value}</span>
                    <span className="w-9 text-right text-xs text-muted-foreground">{percent}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
