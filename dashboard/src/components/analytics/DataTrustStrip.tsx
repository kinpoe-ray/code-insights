import { CheckCircle2, Clock3, Database, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useLocale } from '@/i18n/LocaleProvider';
import { parseStoredTimestamp } from '@/lib/date-utils';
import { cn } from '@/lib/utils';

interface DataTrustStripProps {
  totalSessions: number;
  analyzedSessions: number;
  usageCoveredSessions: number;
  latestSyncAt: string | null;
  latestAnalysisAt: string | null;
}

function coveragePercent(covered: number, total: number) {
  return total > 0 ? Math.round((covered / total) * 100) : 0;
}

interface CoverageCellProps {
  label: string;
  help: string;
  covered: number;
  total: number;
  icon: React.ElementType;
}

function CoverageCell({ label, help, covered, total, icon: Icon }: CoverageCellProps) {
  const { t } = useLocale();
  const percent = coveragePercent(covered, total);
  return (
    <div className="bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          <Icon className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.8} />
          <span className="truncate">{label}</span>
        </div>
        <span className="font-tabular text-sm font-semibold">{percent}%</span>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('analytics.coverageCount', { covered, total })}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground/80">{help}</p>
    </div>
  );
}

export function DataTrustStrip({
  totalSessions,
  analyzedSessions,
  usageCoveredSessions,
  latestSyncAt,
  latestAnalysisAt,
}: DataTrustStripProps) {
  const { t, formatDate, formatRelativeDate } = useLocale();
  const syncDate = latestSyncAt ? parseStoredTimestamp(latestSyncAt) : null;
  const analysisDate = latestAnalysisAt ? parseStoredTimestamp(latestAnalysisAt) : null;
  const stale = syncDate ? Date.now() - syncDate.getTime() > 24 * 60 * 60 * 1000 : true;
  const FreshnessIcon = stale ? Clock3 : CheckCircle2;

  return (
    <Card className="overflow-hidden" aria-label={t('analytics.dataFreshness')}>
      <CardContent className="p-0">
        <div className="grid gap-px bg-border/55 md:grid-cols-3">
          <CoverageCell
            label={t('analytics.analysisCoverage')}
            help={t('analytics.analysisCoverageHelp')}
            covered={analyzedSessions}
            total={totalSessions}
            icon={Sparkles}
          />
          <CoverageCell
            label={t('analytics.usageCoverage')}
            help={t('analytics.usageCoverageHelp')}
            covered={usageCoveredSessions}
            total={totalSessions}
            icon={Database}
          />
          <div className="bg-card px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <FreshnessIcon className={cn('h-4 w-4', stale ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')} strokeWidth={1.8} />
                {t('analytics.lastSync')}
              </div>
              {syncDate && (
                <span className={cn('text-xs font-medium', stale ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300')}>
                  {stale ? t('analytics.dataNeedsSync') : t('analytics.dataCurrent')}
                </span>
              )}
            </div>
            <div className="mt-3 font-tabular text-lg font-semibold tracking-[-0.02em]">
              {syncDate ? formatRelativeDate(syncDate) : t('analytics.noSync')}
            </div>
            {syncDate && (
              <p className="mt-1 text-xs text-muted-foreground" title={formatDate(syncDate, { dateStyle: 'full', timeStyle: 'medium' })}>
                {formatDate(syncDate, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            <p className="mt-3 text-[11px] leading-4 text-muted-foreground/80">
              {t('analytics.lastAnalysis')}: {analysisDate
                ? formatRelativeDate(analysisDate)
                : '—'}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
