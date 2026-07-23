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
  tokenBreakdown?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
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
  tokenBreakdown,
}: StatsHeroProps) {
  const { t, formatNumber } = useLocale();
  const formatCompact = (value: number) => formatNumber(value, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const showUsage = (totalTokens ?? 0) > 0 || (totalCost ?? 0) > 0;
  const hours = Math.floor(totalDurationMin / 60);
  const minutes = totalDurationMin % 60;
  const duration = totalDurationMin < 60
    ? t('dashboard.duration.minutes', { minutes: totalDurationMin })
    : minutes > 0
      ? t('dashboard.duration.hoursMinutes', { hours, minutes })
      : t('dashboard.duration.hours', { hours });

  const coreCell = (
    key: string,
    label: string,
    value: string,
    Icon: React.ElementType
  ) => (
    <div
      key={key}
      className="flex-1 min-w-[100px] px-3 py-2 border-r border-border last:border-r-0"
    >
      <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
        <Icon className="h-3 w-3" />
        <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-base font-bold text-primary">{value}</div>
    </div>
  );

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap">
          {coreCell('sessions', t('dashboard.stats.sessions'), formatCompact(totalSessions), Zap)}
          {coreCell('messages', t('dashboard.stats.messages'), `${!isExact ? '~' : ''}${formatCompact(totalMessages)}`, MessageSquare)}
          {coreCell('toolCalls', t('dashboard.stats.toolCalls'), `${!isExact ? '~' : ''}${formatCompact(totalToolCalls)}`, Wrench)}
          {coreCell('duration', t('dashboard.stats.codingTime'), `${!isExact ? '~' : ''}${duration}`, Clock)}
          <div
            className={`flex-1 min-w-[100px] px-3 py-2 ${showUsage ? 'border-r border-border' : ''}`}
          >
            <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
              <FolderOpen className="h-3 w-3" />
              <span className="text-[11px] font-medium uppercase tracking-wide">{t('dashboard.stats.projects')}</span>
            </div>
            <div className="text-base font-bold text-primary">{formatCompact(totalProjects)}</div>
          </div>

          {showUsage && (
            <>
              <div className="flex-1 min-w-[100px] px-3 py-2 border-r border-border last:border-r-0">
                <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                  <Coins className="h-3 w-3" />
                  <span className="text-[11px] font-medium uppercase tracking-wide">{t('dashboard.stats.tokens')}</span>
                </div>
                {tokenBreakdown ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className="text-base font-bold text-primary cursor-default"
                        aria-label={t('dashboard.stats.tokenBreakdown')}
                      >
                        {formatCompact(totalTokens ?? 0)}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs space-y-0.5">
                      <p>{t('dashboard.stats.tokenInput')}: {formatCompact(tokenBreakdown.inputTokens)}</p>
                      <p>{t('dashboard.stats.tokenOutput')}: {formatCompact(tokenBreakdown.outputTokens)}</p>
                      <p>{t('dashboard.stats.cacheWrite')}: {formatCompact(tokenBreakdown.cacheCreationTokens)}</p>
                      <p>{t('dashboard.stats.cacheRead')}: {formatCompact(tokenBreakdown.cacheReadTokens)}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <div className="text-base font-bold text-primary">
                    {formatCompact(totalTokens ?? 0)}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-[100px] px-3 py-2 border-r border-border last:border-r-0">
                <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                  <DollarSign className="h-3 w-3" />
                  <span className="text-[11px] font-medium uppercase tracking-wide">{t('dashboard.stats.cost')}</span>
                </div>
                <div className="text-base font-bold text-primary">
                  ${(totalCost ?? 0).toFixed(2)}
                </div>
              </div>

              {topModel && (
                <div className="flex-1 min-w-[100px] px-3 py-2 last:border-r-0">
                  <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                    <Cpu className="h-3 w-3" />
                    <span className="text-[11px] font-medium uppercase tracking-wide">{t('dashboard.stats.topModel')}</span>
                  </div>
                  <div className="text-base font-bold text-primary">
                    {formatModelName(topModel)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
