import { useState, useMemo, useEffect, useCallback } from 'react';
import { useSession, useDeleteSession } from '@/hooks/useSessions';
import { useInsights } from '@/hooks/useInsights';
import { useMessages } from '@/hooks/useMessages';
import { cn } from '@/lib/utils';
import { SESSION_CHARACTER_COLORS, SOURCE_TOOL_COLORS, OUTCOME_DOT } from '@/lib/constants/colors';
import { parseJsonField } from '@/lib/types';
import { getScoreTier, extractPQScore } from '@/lib/score-utils';
import type { Insight, InsightMetadata, Session } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { ErrorCard } from '@/components/ErrorCard';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PromptQualityCard } from '@/components/insights/PromptQualityCard';
import { AnalyzeDropdown } from '@/components/analysis/AnalyzeDropdown';
import { AnalyzeButton } from '@/components/analysis/AnalyzeButton';
import { useAnalysis } from '@/components/analysis/AnalysisContext';
import { useMissingFacets, useBackfillFacets } from '@/hooks/useFacets';
import { useQueuedSessionIds } from '@/hooks/useAnalysisQueue';
import { exportSession } from '@/lib/export-session';
import { CollapsibleInsightItem } from '@/components/sessions/CollapsibleInsightItem';
import { PromptQualityAnalyzeButton } from '@/components/sessions/PromptQualityAnalyzeButton';
import { RenameSessionDialog } from '@/components/sessions/RenameSessionDialog';
import { VitalsStrip } from '@/components/sessions/VitalsStrip';
import { AnalysisCostLine } from '@/components/sessions/AnalysisCostLine';
import { ChatConversation } from '@/components/chat/conversation/ChatConversation';
import { ConversationSearch } from '@/components/chat/conversation/ConversationSearch';
import {
  AlertTriangle,
  Clock,
  Pencil,
  FileText,
  Download,
  BookOpen,
  GitBranch,
  GitCommit,
  GitPullRequest,
  BarChart2,
  Wrench,
  Target,
  Loader2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';

const CHARACTER_LABEL_KEYS: Record<NonNullable<Session['session_character']>, MessageKey> = {
  deep_focus: 'sessions.character.deepFocus',
  bug_hunt: 'sessions.character.bugHunt',
  feature_build: 'sessions.character.featureBuild',
  exploration: 'sessions.character.exploration',
  refactor: 'sessions.character.refactor',
  learning: 'sessions.character.learning',
  quick_task: 'sessions.character.quickTask',
};

const OUTCOME_LABEL_KEYS: Record<string, MessageKey> = {
  success: 'sessions.outcome.success',
  partial: 'sessions.outcome.partial',
  abandoned: 'sessions.outcome.abandoned',
  blocked: 'sessions.outcome.blocked',
};

interface SessionDetailPanelProps {
  sessionId: string;
  onDelete?: () => void;
}

export function SessionDetailPanel({ sessionId, onDelete }: SessionDetailPanelProps) {
  const { t, formatDate } = useLocale();
  const { data: session, isLoading: loading, error } = useSession(sessionId);
  const { data: insights = [] } = useInsights({ sessionId });
  const messagesQuery = useMessages(sessionId);
  const deleteMutation = useDeleteSession();
  const [renameOpen, setRenameOpen] = useState(false);
  const [searchHighlightId, setSearchHighlightId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingAllMessages, setLoadingAllMessages] = useState(false);
  const { getAnalysisState } = useAnalysis();
  // Show cost indicator when either analysis type is actively running
  const sessionAnalysisState = getAnalysisState(sessionId, 'session');
  const pqAnalysisState = getAnalysisState(sessionId, 'prompt_quality');
  const isAnalyzingThisSession =
    sessionAnalysisState?.status === 'analyzing' || pqAnalysisState?.status === 'analyzing';
  const queuedSessionIds = useQueuedSessionIds();
  const isQueuedForAnalysis = queuedSessionIds.has(sessionId);
  const { data: missingFacetsData } = useMissingFacets();
  const backfillMutation = useBackfillFacets();
  const missingFacetIds = useMemo(
    () => new Set(missingFacetsData?.sessionIds ?? []),
    [missingFacetsData]
  );
  const isMissingFacets = useMemo(
    () => insights.length > 0 && missingFacetIds.has(sessionId),
    [insights, missingFacetIds, sessionId]
  );

  const messages = messagesQuery.data?.pages.flat() ?? [];
  const loadingMessages = messagesQuery.isLoading;
  const loadingMore = messagesQuery.isFetchingNextPage;
  const hasMore = messagesQuery.hasNextPage ?? false;

  const fetchAllMessages = useCallback(async () => {
    if (loadingAllMessages || !messagesQuery.hasNextPage) return;
    setLoadingAllMessages(true);
    const MAX_PAGES = 50;
    for (let i = 0; i < MAX_PAGES; i++) {
      const result = await messagesQuery.fetchNextPage();
      if (!result.hasNextPage) break;
    }
    setLoadingAllMessages(false);
  }, [messagesQuery, loadingAllMessages]);

  const prLinks = useMemo(() => {
    const linkSet = new Set<string>();
    const prUrlPattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
    for (const msg of messages) {
      const matches = msg.content.match(prUrlPattern);
      if (matches) {
        for (const match of matches) linkSet.add(match);
      }
    }
    return [...linkSet];
  }, [messagesQuery.data]);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 border-b px-6 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="rounded-lg border px-3 py-2.5">
                <Skeleton className="h-6 w-16 mx-auto" />
                <Skeleton className="h-3 w-12 mx-auto mt-1" />
              </div>
            ))}
          </div>
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="rounded-lg border px-4 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <Skeleton className="h-4 w-2/5" />
                </div>
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-3/4" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="p-6">
        <ErrorCard
          message={error instanceof Error ? error.message : t('sessions.detail.sessionNotFound')}
        />
      </div>
    );
  }

  const nonPromptInsights = insights.filter(
    (i) => i.type !== 'prompt_quality' && i.type !== 'summary'
  );
  const hasPromptQuality = insights.some((i) => i.type === 'prompt_quality');
  const promptQualityInsight = insights.find((i) => i.type === 'prompt_quality') ?? null;
  const promptQualityScore = promptQualityInsight
    ? extractPQScore(parseJsonField<Record<string, unknown>>(promptQualityInsight.metadata, {}))
    : null;

  const summaryInsight = insights.find((i) => i.type === 'summary');
  const summaryMetadata = summaryInsight
    ? parseJsonField<InsightMetadata>(summaryInsight.metadata, {})
    : {};
  const sessionOutcome = summaryMetadata.outcome;
  const summaryText = session.summary || summaryInsight?.content;
  const summaryBulletsRaw = summaryInsight
    ? parseJsonField<string[]>(summaryInsight.bullets, [])
    : [];
  const summaryBullets =
    summaryBulletsRaw.length > 0
      ? summaryBulletsRaw
      : session.summary
        ? session.summary
            .split('\n')
            .filter((l) => l.startsWith('- '))
            .map((l) => l.slice(2))
        : [];
  const summaryTitle =
    summaryInsight?.title ||
    (session.summary
      ? session.summary.split('\n').find((l) => !l.startsWith('- '))?.trim() ||
        t('sessions.detail.sessionSummary')
      : t('sessions.detail.sessionSummary'));

  const startedAt = new Date(session.started_at);
  const endedAt = new Date(session.ended_at);
  const characterColor = session.session_character
    ? SESSION_CHARACTER_COLORS[session.session_character]
    : null;
  const characterLabel = session.session_character
    ? t(CHARACTER_LABEL_KEYS[session.session_character])
    : null;
  const sessionTitle = session.custom_title
    || session.generated_title
    || session.summary
    || t('sessions.untitled');
  const sameDay =
    startedAt.getFullYear() === endedAt.getFullYear()
    && startedAt.getMonth() === endedAt.getMonth()
    && startedAt.getDate() === endedAt.getDate();
  const dateTimeOptions: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  const dateRange = sameDay
    ? `${formatDate(startedAt, dateTimeOptions)} – ${formatDate(endedAt, { hour: 'numeric', minute: '2-digit' })}`
    : `${formatDate(startedAt, dateTimeOptions)} – ${formatDate(endedAt, dateTimeOptions)}`;

  function handleExport(format: 'plain' | 'obsidian' | 'notion') {
    exportSession(session!, insights, summaryText, format);
    const formatLabel = format === 'plain' ? 'Markdown' : format === 'obsidian' ? 'Obsidian' : 'Notion';
    toast.success(t('sessions.detail.exportedAs', { format: formatLabel }));
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b px-6 py-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-semibold leading-tight">{sessionTitle}</h1>
          {sessionOutcome && OUTCOME_DOT[sessionOutcome] && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn('w-2 h-2 rounded-full shrink-0', OUTCOME_DOT[sessionOutcome].color)} />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {OUTCOME_LABEL_KEYS[sessionOutcome]
                  ? t(OUTCOME_LABEL_KEYS[sessionOutcome])
                  : OUTCOME_DOT[sessionOutcome].label}
              </TooltipContent>
            </Tooltip>
          )}
          {characterLabel && characterColor && (
            <Badge variant="outline" className={cn('text-xs shrink-0', characterColor)}>
              {characterLabel}
            </Badge>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => setRenameOpen(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                <span className="sr-only">{t('sessions.detail.rename')}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('sessions.detail.rename')}</TooltipContent>
          </Tooltip>
          <div className="ml-auto flex items-center gap-1">
            <AnalyzeDropdown
              session={session}
              hasExistingInsights={nonPromptInsights.length > 0}
              insightCount={nonPromptInsights.length}
              hasExistingPromptQuality={hasPromptQuality}
            />
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <Download className="h-3.5 w-3.5" />
                      <span className="sr-only">{t('sessions.detail.export')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('sessions.detail.export')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleExport('plain')}>
                  {t('sessions.detail.exportMarkdown')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExport('obsidian')}>
                  {t('sessions.detail.exportObsidian')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExport('notion')}>
                  {t('sessions.detail.exportNotion')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialog>
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">{t('sessions.detail.hide')}</span>
                    </Button>
                  </AlertDialogTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('sessions.detail.hide')}</TooltipContent>
              </Tooltip>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('sessions.detail.hideTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('sessions.detail.hideBeforeCommand')}{' '}
                    <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">code-insights sync --force</code>.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('sessions.detail.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={async () => {
                      try {
                        await deleteMutation.mutateAsync(session.id);
                        toast.success(t('sessions.detail.hiddenToast'));
                        onDelete?.();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : t('sessions.detail.hideFailed'));
                      }
                    }}
                  >
                    {t('sessions.detail.hide')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <Clock className="h-3.5 w-3.5" />
          <span>{dateRange}</span>
          <span>&middot;</span>
          {session.git_remote_url ? (
            <a
              href={session.git_remote_url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              {session.project_name}
            </a>
          ) : (
            <span>{session.project_name}</span>
          )}
          {session.git_branch && (
            <>
              <span>&middot;</span>
              <span className="flex items-center gap-1">
                <GitBranch className="h-3 w-3" />
                <span className="font-mono text-[11px] truncate max-w-[160px]">{session.git_branch}</span>
              </span>
            </>
          )}
          {session.tool_call_count > 0 && (
            <>
              <span>&middot;</span>
              <span className="flex items-center gap-1">
                <Wrench className="h-3 w-3" />
                {t('sessions.detail.tools', { count: session.tool_call_count })}
              </span>
            </>
          )}
          {session.source_tool && (
            <>
              <span>&middot;</span>
              <Badge
                variant="outline"
                className={cn(
                  'text-xs capitalize',
                  SOURCE_TOOL_COLORS[session.source_tool] ?? 'bg-muted text-muted-foreground'
                )}
              >
                {session.source_tool}
              </Badge>
            </>
          )}
        </div>
      </div>

      {/* Tabs: Insights | Prompt Quality | Conversation */}
      <Tabs defaultValue="insights" className="flex flex-col flex-1 overflow-hidden pt-2">
        <TabsList variant="line" className="shrink-0 w-full justify-start gap-4 px-6 border-b">
          <TabsTrigger value="insights" className="px-0">
            {t('sessions.detail.tabs.insights')}{nonPromptInsights.length > 0 && ` (${nonPromptInsights.length})`}
          </TabsTrigger>
          <TabsTrigger value="prompt-quality" className="px-0">
            <span className="flex items-center gap-1.5" aria-label={promptQualityScore != null ? t('sessions.detail.promptQualityAria', { score: promptQualityScore }) : t('sessions.detail.tabs.promptQuality')}>
              {t('sessions.detail.tabs.promptQuality')}
              {promptQualityScore != null && (
                <span className={cn(
                  'inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                  { excellent: 'bg-green-500/15 text-green-600', good: 'bg-yellow-500/15 text-yellow-600', fair: 'bg-orange-500/15 text-orange-600', poor: 'bg-red-500/15 text-red-600' }[getScoreTier(promptQualityScore)]
                )}>
                  {promptQualityScore}
                </span>
              )}
            </span>
          </TabsTrigger>
          <TabsTrigger value="conversation" className="px-0">
            {t('sessions.detail.tabs.conversation', { count: session.message_count })}
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Insights */}
        <TabsContent value="insights" className="flex-1 overflow-y-auto mt-0 p-5 space-y-4">
          <VitalsStrip session={session} />

          {/* Queue in-progress indicator — shown when session is awaiting background analysis */}
          {isQueuedForAnalysis && !isAnalyzingThisSession && (
            <div className="flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-2.5">
              <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />
              <p className="text-sm text-muted-foreground">
                {t('sessions.detail.analysisInProgress')}
              </p>
            </div>
          )}

          {/* Analysis cost indicator — only shown when analysis has been run or is running */}
          {(insights.length > 0 || isAnalyzingThisSession) && (
            <AnalysisCostLine sessionId={sessionId} isAnalyzing={isAnalyzingThisSession} />
          )}

          {/* Missing facets banner */}
          {isMissingFacets && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                <p className="text-sm text-muted-foreground">
                  {t('sessions.detail.missingPatterns')}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5 text-xs"
                disabled={backfillMutation.isPending}
                onClick={() => {
                  backfillMutation.mutate([sessionId], {
                    onSuccess: () => toast.success(t('sessions.detail.facetsExtracted')),
                    onError: (err) => toast.error(
                      err instanceof Error ? err.message : t('sessions.detail.facetsFailed')
                    ),
                  });
                }}
              >
                {backfillMutation.isPending ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('sessions.detail.extracting')}
                  </>
                ) : (
                  t('sessions.detail.extractFacets')
                )}
              </Button>
            </div>
          )}

          {/* Summary */}
          {summaryText && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <FileText className="h-4 w-4 text-purple-500 shrink-0" />
                <h3 className="text-sm font-medium">{t('sessions.detail.summary')}</h3>
              </div>
              <div className="rounded-md bg-muted/20 px-4 py-3">
                <p className="font-medium text-sm mb-1.5">{summaryTitle}</p>
                {summaryBullets.length > 0 ? (
                  <ul className="list-disc list-inside space-y-0.5 text-sm text-muted-foreground">
                    {summaryBullets.map((bullet, i) => (
                      <li key={i}>{bullet}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{summaryText}</p>
                )}
              </div>
            </div>
          )}

          {/* PR Links */}
          {prLinks.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">{t('sessions.detail.pullRequests')}</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                {prLinks.map((url) => {
                  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
                  const label = match ? `${match[2]}#${match[3]}` : url;
                  return (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                      <Badge variant="outline" className="text-xs hover:bg-accent cursor-pointer gap-1">
                        <GitPullRequest className="h-3 w-3" />
                        {label}
                      </Badge>
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {/* Learnings & Decisions */}
          {insights.filter((i) => i.type !== 'summary' && i.type !== 'prompt_quality').length === 0 ? (
            <div className="rounded-lg border border-dashed">
              <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                <BarChart2 className="h-8 w-8 text-muted-foreground" />
                <p className="font-medium text-sm">{t('sessions.detail.notAnalyzed')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('sessions.detail.notAnalyzedDescription')}
                </p>
                <div className="pt-2">
                  <AnalyzeButton
                    session={session}
                    hasExistingInsights={false}
                    insightCount={0}
                  />
                </div>
              </div>
            </div>
          ) : (
            <>
              {(() => {
                const learningInsights = insights.filter(
                  (i) => i.type === 'learning' || i.type === 'technique'
                );
                if (learningInsights.length === 0) return null;
                return (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <BookOpen className="h-4 w-4 text-green-500" />
                      <h3 className="text-sm font-medium">{t('sessions.detail.learnings')}</h3>
                      <Badge variant="secondary" className="text-xs">
                        {learningInsights.length}
                      </Badge>
                    </div>
                    <div className="rounded-md border">
                      {learningInsights.map((insight) => (
                        <CollapsibleInsightItem key={insight.id} insight={insight} />
                      ))}
                    </div>
                  </div>
                );
              })()}

              {(() => {
                const decisionInsights = insights.filter((i) => i.type === 'decision');
                if (decisionInsights.length === 0) return null;
                return (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <GitCommit className="h-4 w-4 text-blue-500" />
                      <h3 className="text-sm font-medium">{t('sessions.detail.decisions')}</h3>
                      <Badge variant="secondary" className="text-xs">
                        {decisionInsights.length}
                      </Badge>
                    </div>
                    <div className="rounded-md border">
                      {decisionInsights.map((insight) => (
                        <CollapsibleInsightItem key={insight.id} insight={insight} />
                      ))}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </TabsContent>

        {/* Tab 2: Prompt Quality */}
        <TabsContent value="prompt-quality" className="flex-1 overflow-y-auto mt-0 p-5 space-y-4">
          {promptQualityInsight ? (
            <PromptQualityCard insight={promptQualityInsight} />
          ) : (
            <div className="rounded-lg border border-dashed">
              <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
                <Target className="h-8 w-8 text-muted-foreground" />
                <p className="font-medium text-sm">{t('sessions.detail.noPromptQuality')}</p>
                <p className="text-xs text-muted-foreground max-w-[280px]">
                  {t('sessions.detail.noPromptQualityDescription')}
                </p>
                <div className="pt-2">
                  <PromptQualityAnalyzeButton session={session} />
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Tab 3: Conversation */}
        <TabsContent
          value="conversation"
          className="flex flex-col flex-1 overflow-hidden mt-0 bg-muted/40 dark:bg-muted/20"
        >
          <ConversationSearch
            messages={messages}
            onHighlightMessage={setSearchHighlightId}
            onSearchQueryChange={setSearchQuery}
            fetchAllMessages={fetchAllMessages}
            isLoadingAll={loadingAllMessages}
          />
          <div className="flex-1 overflow-y-auto">
            <ChatConversation
              messages={messages}
              loading={loadingMessages}
              loadingMore={loadingMore}
              hasMore={hasMore}
              onLoadMore={() => messagesQuery.fetchNextPage()}
              sourceTool={session.source_tool ?? undefined}
              highlightMessageId={searchHighlightId}
              searchQuery={searchQuery}
            />
          </div>
        </TabsContent>
      </Tabs>

      {/* Rename dialog */}
      <RenameSessionDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        sessionId={session.id}
        currentTitle={sessionTitle}
      />
    </div>
  );
}
