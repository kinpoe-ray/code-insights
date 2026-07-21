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

interface BulkAnalyzeButtonProps {
  sessions: Session[];
  onComplete?: () => void;
}

export function BulkAnalyzeButton({
  sessions,
  onComplete,
}: BulkAnalyzeButtonProps) {
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
        error instanceof Error ? error.message : 'Unable to queue analysis',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!configured) {
    return (
      <Button variant="outline" disabled className="gap-2">
        <Sparkles className="h-4 w-4" />
        Analyze Selected
        <span className="text-xs text-muted-foreground ml-1">
          (Configure AI first)
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
          Analyze {sessions.length} Session{sessions.length !== 1 ? 's' : ''}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk Analysis</DialogTitle>
          <DialogDescription>
            Generate AI insights for {sessions.length} selected session
            {sessions.length !== 1 ? 's' : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!receipt && (
            <>
              <p className="text-sm text-muted-foreground">
                The sessions will be added to a durable background queue. You
                can close this window while analysis continues.
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
                {submitting ? 'Queueing Analysis...' : 'Start Analysis'}
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
                    : 'Unable to load batch status'}
                </span>
              </div>
              <Button
                variant="outline"
                onClick={retrySnapshot}
                className="w-full"
              >
                Retry
              </Button>
            </div>
          )}

          {receipt && !queueError && !progress && (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading batch status...</span>
            </div>
          )}

          {receipt && !queueError && progress && !progress.isComplete && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm" aria-live="polite">
                  {progress.finished} of {progress.total} finished
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="Batch analysis progress"
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
                {progress.processing} processing · {progress.pending} waiting
              </p>
            </div>
          )}

          {receipt && !queueError && progress?.isComplete && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="h-4 w-4" />
                <span aria-live="polite">
                  {progress.completed} session
                  {progress.completed !== 1 ? 's' : ''} analyzed successfully
                </span>
              </div>
              {progress.failed > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-red-500">
                    <AlertCircle className="h-4 w-4" />
                    <span>{progress.failed} failed</span>
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
                      <li>...and {progress.errors.length - 5} more</li>
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
                  Analyze Again
                </Button>
                <Button
                  onClick={() => setOpen(false)}
                  className="flex-1"
                >
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
