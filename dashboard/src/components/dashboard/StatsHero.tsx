import { Card, CardContent } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatModelName } from '@/lib/utils';
import { useLocale } from '@/i18n/LocaleProvider';
import {
  MessageSquare,
  Wrench,
  Clock,
  FolderOpen,
  Zap,
  Coins,
  DollarSign,
  Cpu,
} from 'lucide-react';

interface StatsHeroProps {
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
  totalDurationMin: number;
  totalProjects: number;
  isExact: boolean;
  totalTokens?: number;
  totalCost?: number;
  topModel?: string | null;
  usageCoverage?: { covered: number; total: number };
  tokenBreakdown?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

interface MetricProps {
  label: string;
  value: string;
  detail?: string;
  icon: React.ElementType;
}

function Metric({ label, value, detail, icon: Icon }: MetricProps) {
  return (
    <div className="min-w-0 bg-card px-4 py-4 sm:px-5 sm:py-5">
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary/9 text-primary">
        <Icon className="h-4 w-4" strokeWidth={1.8} />
      </div>
      <div className="font-tabular truncate text-[clamp(1.35rem,2vw,1.75rem)] font-semibold leading-none tracking-[-0.035em]">
        {value}
      </div>
      <div className="mt-2 text-[13px] font-medium text-foreground/85">{label}</div>
      {detail && <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

export function StatsHero({
  totalSessions,
  totalMessages,
  totalToolCalls,
  totalDurationMin,
  totalProjects,
  isExact,
  totalTokens,
  totalCost,
  topModel,
  usageCoverage,
  tokenBreakdown,
}: StatsHeroProps) {
  const { t, formatNumber } = useLocale();
  const formatCompact = (value: number) => formatNumber(value, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const hours = Math.floor(totalDurationMin / 60);
  const minutes = totalDurationMin % 60;
  const duration = totalDurationMin < 60
    ? t('dashboard.duration.minutes', { minutes: totalDurationMin })
    : minutes > 0
      ? t('dashboard.duration.hoursMinutes', { hours, minutes })
      : t('dashboard.duration.hours', { hours });

  const usageDetail = usageCoverage && usageCoverage.total > 0
    ? t('dashboard.stats.usageCoverage', {
        covered: usageCoverage.covered,
        total: usageCoverage.total,
      })
    : totalTokens
      ? t('dashboard.stats.tokensDetail', { tokens: formatCompact(totalTokens) })
      : undefined;

  const hasUsageCost = usageCoverage
    ? usageCoverage.covered > 0
    : (totalCost ?? 0) > 0;
  const usageMetric = hasUsageCost
    ? {
        label: t('dashboard.stats.estimatedCost'),
        value: `$${(totalCost ?? 0).toFixed(2)}`,
        detail: usageDetail,
        icon: DollarSign,
      }
    : {
        label: t('dashboard.stats.tokens'),
        value: totalTokens ? formatCompact(totalTokens) : '—',
        detail: topModel ? formatModelName(topModel) : undefined,
        icon: totalTokens ? Coins : Cpu,
      };

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="grid gap-px bg-border/55 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <Metric
            label={t('dashboard.stats.sessions')}
            value={formatCompact(totalSessions)}
            icon={Zap}
          />
          <Metric
            label={t('dashboard.stats.codingTime')}
            value={`${!isExact ? '~' : ''}${duration}`}
            icon={Clock}
          />
          <Metric
            label={t('dashboard.stats.messages')}
            value={`${!isExact ? '~' : ''}${formatCompact(totalMessages)}`}
            icon={MessageSquare}
          />
          <Metric
            label={t('dashboard.stats.toolCalls')}
            value={`${!isExact ? '~' : ''}${formatCompact(totalToolCalls)}`}
            icon={Wrench}
          />
          <Metric
            label={t('dashboard.stats.projects')}
            value={formatCompact(totalProjects)}
            icon={FolderOpen}
          />
          {tokenBreakdown ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="cursor-help" aria-label={t('dashboard.stats.tokenBreakdown')}>
                  <Metric {...usageMetric} />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="space-y-1 rounded-xl p-3 text-xs">
                <p>{t('dashboard.stats.tokenInput')}: {formatCompact(tokenBreakdown.inputTokens)}</p>
                <p>{t('dashboard.stats.tokenOutput')}: {formatCompact(tokenBreakdown.outputTokens)}</p>
                <p>{t('dashboard.stats.cacheWrite')}: {formatCompact(tokenBreakdown.cacheCreationTokens)}</p>
                <p>{t('dashboard.stats.cacheRead')}: {formatCompact(tokenBreakdown.cacheReadTokens)}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Metric {...usageMetric} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
