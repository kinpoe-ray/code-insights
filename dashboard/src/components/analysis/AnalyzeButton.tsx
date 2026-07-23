import { useState } from 'react';
import { Sparkles, Loader2, AlertCircle, CheckCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Link } from 'react-router';
import { useAnalysis } from './AnalysisContext';
import { useLlmConfig } from '@/hooks/useConfig';
import type { Session } from '@/lib/types';
import { useLocale } from '@/i18n/LocaleProvider';

interface AnalyzeButtonProps {
  session: Session;
  hasExistingInsights?: boolean;
  insightCount?: number;
}

export function AnalyzeButton({ session, hasExistingInsights, insightCount }: AnalyzeButtonProps) {
  const { t } = useLocale();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { getAnalysisState, startAnalysis, cancelAnalysis } = useAnalysis();
  const { data: llmConfig } = useLlmConfig();

  const configured = !!(llmConfig?.provider && llmConfig?.model);

  const analysisState = getAnalysisState(session.id, 'session');
  const isAnalyzingThisSession = analysisState?.status === 'analyzing';
  const isCompleteForThisSession =
    (analysisState?.status === 'complete' || analysisState?.status === 'error');

  const handleAnalyze = () => {
    startAnalysis(session, 'session');
  };

  const handleClick = () => {
    if (hasExistingInsights && !isCompleteForThisSession) {
      setConfirmOpen(true);
    } else {
      handleAnalyze();
    }
  };

  const isReanalyze = hasExistingInsights || isCompleteForThisSession;

  if (!configured) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        <span>
          {t('analysis.configurePrefix')}{' '}
          <Link to="/settings" className="underline hover:text-foreground">
            {t('analysis.settings')}
          </Link>{' '}
          {t('analysis.configureSuffix')}
        </span>
      </div>
    );
  }

  if (isAnalyzingThisSession) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Button disabled variant="outline" className="gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {analysisState?.progress?.message || t('analysis.analyzingNamed', {
              title: analysisState?.sessionTitle ?? '',
            })}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => cancelAnalysis(session.id, 'session')}
          >
            <X className="h-3.5 w-3.5" />
            {t('analysis.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button
          onClick={handleClick}
          variant={isReanalyze ? 'outline' : 'default'}
          className="gap-2"
        >
          {isReanalyze ? (
            <>
              <CheckCircle className="h-4 w-4 text-green-500" />
              {t('analysis.reanalyzeSession')}
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              {t('analysis.analyzeSession')}
            </>
          )}
        </Button>

        {!isReanalyze && (
          <span className="text-xs text-muted-foreground">
            {t('analysis.messageCount', { count: session.message_count })}
          </span>
        )}
      </div>

      {isReanalyze && !isCompleteForThisSession && (
        <p className="text-xs text-muted-foreground">
          {t('analysis.replacesInsights')}
        </p>
      )}

      {isCompleteForThisSession && analysisState?.result?.success && (
        <div className="text-sm text-green-600">
          {analysisState.result.insightCount != null
            ? t('analysis.completeCount', { count: analysisState.result.insightCount })
            : t('analysis.complete')}
        </div>
      )}

      {isCompleteForThisSession && !analysisState?.result?.success && (
        <div className="flex items-start gap-2 text-sm text-red-500">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{analysisState?.result?.error || t('analysis.failed')}</span>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('analysis.confirmSessionTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('analysis.confirmSessionDescription', { count: insightCount ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('analysis.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleAnalyze}>{t('analysis.reanalyze')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
