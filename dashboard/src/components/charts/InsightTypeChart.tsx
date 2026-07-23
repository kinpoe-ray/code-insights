import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
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

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('analytics.insightTypes')}</CardTitle>
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
        <CardTitle className="text-base">{t('analytics.insightTypes')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={70}
                paddingAngle={2}
                dataKey="value"
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: tooltipBg,
                  borderColor: tooltipBorder,
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend
                formatter={(value) => <span className="text-sm">{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
