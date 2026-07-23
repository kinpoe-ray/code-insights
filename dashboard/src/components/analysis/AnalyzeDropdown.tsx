import { useState } from 'react';
import { Sparkles, Loader2, X, ChevronDown, Target, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useAnalysisCost } from '@/hooks/useAnalysisCost';
import { estimateAnalysisCost, formatCost, formatEstimatedInputTokens } from '@/lib/cost-utils';
import type { Session } from '@/lib/types';
import { useLocale } from '@/i18n/LocaleProvider';

interface AnalyzeDropdownProps {
  session: Session;
  hasExistingInsights?: boolean;
  insightCount?: number;
  hasExistingPromptQuality?: boolean;
}

export function AnalyzeDropdown({
  session,
  hasExistingInsights,
  insightCount,
  hasExistingPromptQuality,
}: AnalyzeDropdownProps) {
  const { t } = useLocale();
  const [confirmSessionOpen, setConfirmSessionOpen] = useState(false);
  const [confirmPromptOpen, setConfirmPromptOpen] = useState(false);
  const { getAnalysisState, startAnalysis, cancelAnalysis } = useAnalysis();
  const { data: llmConfig } = useLlmConfig();
  const { data: costData } = useAnalysisCost(session.id);

  const configured = !!(llmConfig?.provider && llmConfig?.model);
  // Local providers with no per-token cost
  const isLocalFreeProvider = llmConfig?.provider === 'ollama' || llmConfig?.provider === 'llamacpp';
  const isOllama = isLocalFreeProvider;

  // Client-side cost estimates (shown in dropdown sublabels)
  const sessionCostEstimate =
    llmConfig?.provider && llmConfig?.model
      ? estimateAnalysisCost(session, llmConfig.provider, llmConfig.model, 'session')
      : null;

  const pqCostEstimate =
    llmConfig?.provider && llmConfig?.model
      ? estimateAnalysisCost(session, llmConfig.provider, llmConfig.model, 'prompt_quality')
      : null;

  // Anthropic cache hint: shown when session analysis has run but PQ has not
  const sessionAnalysisRan = costData?.usage.some(r => r.analysis_type === 'session') ?? false;
  const pqAnalysisRan = costData?.usage.some(r => r.analysis_type === 'prompt_quality') ?? false;
  const showCacheHint =
    llmConfig?.provider === 'anthropic' && sessionAnalysisRan && !pqAnalysisRan;

  const inputTokensLabel = formatEstimatedInputTokens(session);

  const sessionAnalysisState = getAnalysisState(session.id, 'session');
  const pqAnalysisState = getAnalysisState(session.id, 'prompt_quality');

  const isAnalyzingSession = sessionAnalysisState?.status === 'analyzing';
  const isAnalyzingPq = pqAnalysisState?.status === 'analyzing';
  // Either analysis type is running on this session
  const isAnalyzingThisSession = isAnalyzingSession || isAnalyzingPq;

  const isCompleteForSession =
    sessionAnalysisState?.status === 'complete';

  const handleSessionAnalyze = () => {
    startAnalysis(session, 'session');
  };

  const handlePromptAnalyze = () => {
    startAnalysis(session, 'prompt_quality');
  };

  const handleSessionClick = () => {
    if (hasExistingInsights && !isCompleteForSession) {
      setConfirmSessionOpen(true);
    } else {
      handleSessionAnalyze();
    }
  };

  const handlePromptClick = () => {
    const isCompleteForPrompt = pqAnalysisState?.status === 'complete';

    if (hasExistingPromptQuality && !isCompleteForPrompt) {
      setConfirmPromptOpen(true);
    } else {
      handlePromptAnalyze();
    }
  };

  if (!configured) {
    return (
      <Link
        to="/settings"
        className="text-xs text-muted-foreground underline hover:text-foreground"
      >
        {t('analysis.configureAi')}
      </Link>
    );
  }

  // Show spinner for whichever analysis is currently running on this session
  if (isAnalyzingThisSession) {
    const activeState = isAnalyzingSession ? sessionAnalysisState : pqAnalysisState;
    const activeType = isAnalyzingSession ? 'session' : 'prompt_quality';
    return (
      <div className="flex items-center gap-1.5">
        <Button disabled variant="outline" size="sm" className="h-8 gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="hidden sm:inline">
            {activeState?.progress?.message || t('analysis.analyzing')}
          </span>
          <span className="sm:hidden">{t('analysis.analyzing')}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-muted-foreground hover:text-foreground"
          onClick={() => cancelAnalysis(session.id, activeType)}
        >
          <X className="h-3.5 w-3.5" />
          <span className="sr-only sm:not-sr-only">{t('analysis.cancel')}</span>
        </Button>
      </div>
    );
  }

  const showPromptOption = session.user_message_count >= 2;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            {t('analysis.analyze')}
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleSessionClick}>
            <Sparkles className="h-4 w-4" />
            {hasExistingInsights ? t('analysis.reanalyzeSession') : t('analysis.analyzeSession')}
            {sessionCostEstimate !== null && (
              <div className="text-xs text-muted-foreground pl-7 pb-1 w-full">
                {isOllama
                  ? t('analysis.freeLocal')
                  : `~${formatCost(sessionCostEstimate)}${inputTokensLabel ? ` · ${inputTokensLabel}` : ''}`}
              </div>
            )}
          </DropdownMenuItem>
          {showPromptOption && (
            <DropdownMenuItem onClick={handlePromptClick}>
              <Target className="h-4 w-4" />
              {hasExistingPromptQuality
                ? t('analysis.reanalyzePromptQuality')
                : t('analysis.analyzePromptQuality')}
              {pqCostEstimate !== null && (
                <div className="text-xs text-muted-foreground pl-7 pb-0.5 w-full">
                  {isOllama
                    ? t('analysis.freeLocal')
                    : `~${formatCost(pqCostEstimate)} · ${t('analysis.sameConversation')}`}
                </div>
              )}
              {showCacheHint && (
                <div className="text-[10px] text-muted-foreground/60 pl-7 italic flex items-center gap-1 pb-1 w-full">
                  <Info className="h-3 w-3 shrink-0" />
                  {t('analysis.cacheHint')}
                </div>
              )}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmSessionOpen} onOpenChange={setConfirmSessionOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('analysis.confirmSessionTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  {t('analysis.confirmSessionDescription', { count: insightCount ?? 0 })}
                </p>
                {sessionCostEstimate !== null && !isOllama && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('analysis.estimatedCost', { cost: formatCost(sessionCostEstimate) })}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('analysis.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSessionAnalyze}>{t('analysis.reanalyze')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmPromptOpen} onOpenChange={setConfirmPromptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('analysis.confirmPromptTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  {t('analysis.confirmPromptDescription')}
                </p>
                {pqCostEstimate !== null && !isOllama && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('analysis.estimatedCost', { cost: formatCost(pqCostEstimate) })}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('analysis.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handlePromptAnalyze}>{t('analysis.reanalyze')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
