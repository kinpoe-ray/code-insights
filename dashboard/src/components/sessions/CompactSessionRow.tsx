import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SESSION_CHARACTER_COLORS, SOURCE_TOOL_COLORS, OUTCOME_DOT } from '@/lib/constants/colors';
import { formatDuration, cn } from '@/lib/utils';
import { Sparkles, Target, Loader2 } from 'lucide-react';
import type { Session } from '@/lib/types';
import { getScoreTier } from '@/lib/score-utils';
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

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  'codex-cli': 'Codex CLI',
  'copilot-cli': 'Copilot CLI',
  copilot: 'Copilot',
};

const SCORE_TEXT_COLORS: Record<string, string> = {
  excellent: 'text-green-600',
  good: 'text-yellow-600',
  fair: 'text-orange-600',
  poor: 'text-red-600',
};

interface CompactSessionRowProps {
  session: Session;
  isActive: boolean;
  showProject: boolean;
  insightCounts?: Record<string, number>;
  outcome?: string;
  promptQualityScore?: number;
  isAnalyzed?: boolean;
  missingFacets?: boolean;
  isQueued?: boolean;
  onClick: () => void;
}

export function CompactSessionRow({
  session,
  isActive,
  showProject,
  insightCounts,
  outcome,
  promptQualityScore,
  isAnalyzed = false,
  missingFacets,
  isQueued = false,
  onClick,
}: CompactSessionRowProps) {
  const { t, formatDate } = useLocale();
  const startedAt = new Date(session.started_at);
  const endedAt = new Date(session.ended_at);
  const title = session.custom_title
    || session.generated_title
    || session.summary
    || t('sessions.untitled');
  const characterColor = session.session_character
    ? (SESSION_CHARACTER_COLORS[session.session_character] ?? 'bg-muted text-muted-foreground')
    : null;

  const sourceLabel = session.source_tool
    ? (SOURCE_LABELS[session.source_tool] ?? session.source_tool)
    : null;

  const insightTotal = insightCounts
    ? Object.entries(insightCounts)
        .filter(([type]) => type !== 'summary')
        .reduce((sum, [, n]) => sum + n, 0)
    : 0;
  const startedTime = formatDate(startedAt, { hour: '2-digit', minute: '2-digit' });

  return (
    <button
      onClick={onClick}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'w-full border-b border-b-border/60 border-l-2 px-4 py-3.5 text-left transition-colors',
        isActive
          ? 'border-l-orange-500 bg-accent/60'
          : 'border-l-transparent hover:bg-accent/35'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-semibold leading-snug">{title}</p>

          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
            <span className="shrink-0">{startedTime}</span>
            {sourceLabel && (
              <>
                <span className="text-muted-foreground/30">&middot;</span>
                <Badge
                  variant="outline"
                  className={cn(
                    'h-5 max-w-28 shrink-0 px-1.5 py-0 text-[10px] font-normal',
                    SOURCE_TOOL_COLORS[session.source_tool ?? ''] ?? 'bg-muted text-muted-foreground'
                  )}
                >
                  <span className="truncate">{sourceLabel}</span>
                </Badge>
              </>
            )}
            {session.session_character && characterColor && (
              <>
                <span className="text-muted-foreground/30">&middot;</span>
                <Badge
                  variant="outline"
                  className={cn('h-5 max-w-24 shrink-0 px-1.5 py-0 text-[10px] font-normal', characterColor)}
                >
                  <span className="truncate">{t(CHARACTER_LABEL_KEYS[session.session_character])}</span>
                </Badge>
              </>
            )}
            {showProject && (
              <>
                <span className="text-muted-foreground/30">&middot;</span>
                <span className="truncate">{session.project_name}</span>
              </>
            )}
          </div>
        </div>

        {isQueued && (
          <Badge variant="outline" className="shrink-0 gap-0.5 border-blue-300 px-1.5 py-0 text-[10px] text-blue-600">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            {t('sessions.rowAnalyzing')}
          </Badge>
        )}
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span>{formatDuration(startedAt, endedAt)}</span>
        <span className="text-muted-foreground/30">&middot;</span>
        <span>{t('sessions.rowMessages', { count: session.message_count })}</span>
        <span className="text-muted-foreground/30">&middot;</span>
        <span className={cn('flex items-center gap-1', isAnalyzed ? 'text-emerald-600' : 'text-muted-foreground/70')}>
          <span className={cn('h-1.5 w-1.5 rounded-full', isAnalyzed ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
          {isAnalyzed ? t('sessions.rowAnalyzed') : t('sessions.rowNotAnalyzed')}
        </span>

        {outcome && OUTCOME_DOT[outcome] && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn('w-2 h-2 rounded-full shrink-0', OUTCOME_DOT[outcome].color)} />
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              {OUTCOME_LABEL_KEYS[outcome] ? t(OUTCOME_LABEL_KEYS[outcome]) : OUTCOME_DOT[outcome].label}
            </TooltipContent>
          </Tooltip>
        )}
        {insightTotal > 0 && (
          <>
            <span className="text-muted-foreground/30">&middot;</span>
            {missingFacets ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-0.5 text-amber-500/80">
                    <Sparkles className="h-2.5 w-2.5" />
                    {insightTotal}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs max-w-[200px]">
                  {t('sessions.row.missingPatterns')} <code className="text-[10px]">reflect backfill</code>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="flex items-center gap-0.5 text-purple-500/80">
                <Sparkles className="h-2.5 w-2.5" />
                {insightTotal}
              </span>
            )}
          </>
        )}
        {promptQualityScore != null && (
          <>
            <span className="text-muted-foreground/30">&middot;</span>
            <span className={cn('flex items-center gap-0.5', SCORE_TEXT_COLORS[getScoreTier(promptQualityScore)])}>
              <Target className="h-2.5 w-2.5" />
              {promptQualityScore}
            </span>
          </>
        )}
        {session.estimated_cost_usd != null && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            ${session.estimated_cost_usd.toFixed(2)}
          </span>
        )}
      </div>
    </button>
  );
}
