import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { enqueueAnalysisBatch } from '@/lib/api';
import { useLlmConfig } from '@/hooks/useConfig';
import { useAnalysisBatchQueue } from '@/hooks/useAnalysisQueue';
import type { Session } from '@/lib/types';
import { useLocale } from '@/i18n/LocaleProvider';

interface BulkAnalyzeButtonProps {
  sessions: Session[];
  onComplete?: () => void;
}

export function BulkAnalyzeButton({
  sessions,
  onComplete,
}: BulkAnalyzeButtonProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { data: llmConfig } = useLlmConfig();
  const sessionIds = sessions.map((session) => session.id);
  const {
    receipt,
    progress,
    rememberReceipt,
    clearReceipt,
    error: queueError,
    retrySnapshot,
  } = useAnalysisBatchQueue({ onComplete, sessionIds });

  const configured = !!(llmConfig?.provider && llmConfig?.model);

  const handleAnalyze = async () => {
    if (!configured || sessions.length === 0 || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await enqueueAnalysisBatch(
        sessionIds,
      );
      rememberReceipt(response.batch);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : t('analysis.bulk.unableQueue'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!configured) {
    return (
      <Button variant="outline" disabled className="gap-2">
        <Sparkles className="h-4 w-4" />
        {t('analysis.bulk.analyzeSelected')}
        <span className="text-xs text-muted-foreground ml-1">
          {t('analysis.bulk.configureFirst')}
        </span>
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="gap-2"
          disabled={sessions.length === 0}
          onClick={() => setOpen(true)}
        >
          <Sparkles className="h-4 w-4" />
          {t('analysis.bulk.trigger', { count: sessions.length })}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('analysis.bulk.title')}</DialogTitle>
          <DialogDescription>
            {t('analysis.bulk.description', { count: sessions.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!receipt && (
            <>
              <p className="text-sm text-muted-foreground">
                {t('analysis.bulk.queueHelp')}
              </p>
              {submitError && (
                <div className="flex items-start gap-2 text-sm text-red-500">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}
              <Button
                onClick={() => { void handleAnalyze(); }}
                className="w-full gap-2"
                disabled={submitting}
              >
                {submitting
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Sparkles className="h-4 w-4" />}
                {submitting ? t('analysis.bulk.queueing') : t('analysis.bulk.start')}
              </Button>
            </>
          )}

          {receipt && queueError && (
            <div
              role="alert"
              className="space-y-3 text-sm text-red-500"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {queueError instanceof Error
                    ? queueError.message
                    : t('analysis.bulk.unableStatus')}
                </span>
              </div>
              <Button
                variant="outline"
                onClick={retrySnapshot}
                className="w-full"
              >
                {t('analysis.bulk.retry')}
              </Button>
            </div>
          )}

          {receipt && !queueError && !progress && (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t('analysis.bulk.loadingStatus')}</span>
            </div>
          )}

          {receipt && !queueError && progress && !progress.isComplete && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm" aria-live="polite">
                  {t('analysis.bulk.finished', {
                    finished: progress.finished,
                    total: progress.total,
                  })}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={t('analysis.bulk.progressLabel')}
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.finished}
                className="w-full bg-muted rounded-full h-2"
              >
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{
                    width: `${progress.total > 0
                      ? (progress.finished / progress.total) * 100
                      : 0}%`,
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('analysis.bulk.processingWaiting', {
                  processing: progress.processing,
                  pending: progress.pending,
                })}
              </p>
            </div>
          )}

          {receipt && !queueError && progress?.isComplete && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="h-4 w-4" />
                <span aria-live="polite">
                  {t('analysis.bulk.success', { count: progress.completed })}
                </span>
              </div>
              {progress.failed > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-red-500">
                    <AlertCircle className="h-4 w-4" />
                    <span>{t('analysis.bulk.failed', { count: progress.failed })}</span>
                  </div>
                  <ul className="text-xs text-muted-foreground list-disc list-inside max-h-32 overflow-y-auto">
                    {progress.errors.slice(0, 5).map((error) => (
                      <li
                        key={error.sessionId}
                        className="truncate"
                        title={error.sessionId}
                      >
                        {error.message}
                      </li>
                    ))}
                    {progress.errors.length > 5 && (
                      <li>{t('analysis.bulk.more', { count: progress.errors.length - 5 })}</li>
                    )}
                  </ul>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={clearReceipt}
                  className="flex-1"
                >
                  {t('analysis.bulk.again')}
                </Button>
                <Button
                  onClick={() => setOpen(false)}
                  className="flex-1"
                >
                  {t('analysis.bulk.done')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
