import { MessageSquare, Lightbulb, GitCommit, BookOpen, FileText, Target, ChevronRight } from 'lucide-react';
import { SearchHighlight } from './SearchHighlight';
import type { SearchSessionResult, SearchInsightResult } from '@/lib/api';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages/catalog';

const CHARACTER_KEYS: Record<string, MessageKey> = {
  deep_focus: 'search.character.deepFocus',
  bug_hunt: 'search.character.bugHunt',
  feature_build: 'search.character.featureBuild',
  exploration: 'search.character.exploration',
  refactor: 'search.character.refactor',
  learning: 'search.character.learning',
  quick_task: 'search.character.quickTask',
};

const INSIGHT_TYPE_KEYS: Record<string, MessageKey> = {
  summary: 'search.insight.summary',
  decision: 'search.insight.decision',
  learning: 'search.insight.learning',
  technique: 'search.insight.technique',
  prompt_quality: 'search.insight.promptQuality',
};

const INSIGHT_ICONS: Record<string, typeof FileText> = {
  summary: FileText,
  decision: GitCommit,
  learning: BookOpen,
  technique: BookOpen,
  prompt_quality: Target,
};

interface SessionResultProps {
  result: SearchSessionResult;
  query: string;
  isActive: boolean;
  onClick: () => void;
}

export function SessionSearchResult({ result, query, isActive, onClick }: SessionResultProps) {
  const { t, formatRelativeDate } = useLocale();
  const characterKey = result.session_character ? CHARACTER_KEYS[result.session_character] : undefined;
  const characterLabel = characterKey
    ? t(characterKey)
    : result.session_character?.replace(/_/g, ' ') ?? null;

  return (
    <div
      role="option"
      aria-selected={isActive}
      onClick={onClick}
      className={`flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
        isActive ? 'bg-accent' : 'hover:bg-accent/50'
      }`}
    >
      <MessageSquare className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-muted-foreground truncate">
          <SearchHighlight text={result.title} query={query} />
        </div>
        <div className="text-xs text-muted-foreground/60 mt-0.5 flex items-center gap-1.5">
          <span className="truncate">{result.project_name}</span>
          {characterLabel && (
            <>
              <span>·</span>
              <span>{characterLabel}</span>
            </>
          )}
          <span>·</span>
          <span>{formatRelativeDate(result.started_at)}</span>
        </div>
        {result.match_field === 'summary' && result.snippet && (
          <div className="text-xs text-muted-foreground/50 mt-0.5 truncate">
            <SearchHighlight text={result.snippet} query={query} />
          </div>
        )}
      </div>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 mt-1" />
    </div>
  );
}

interface InsightResultProps {
  result: SearchInsightResult;
  query: string;
  isActive: boolean;
  onClick: () => void;
}

export function InsightSearchResult({ result, query, isActive, onClick }: InsightResultProps) {
  const { t, formatRelativeDate } = useLocale();
  const Icon = INSIGHT_ICONS[result.type] ?? Lightbulb;
  const insightTypeKey = INSIGHT_TYPE_KEYS[result.type];

  return (
    <div
      role="option"
      aria-selected={isActive}
      onClick={onClick}
      className={`flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
        isActive ? 'bg-accent' : 'hover:bg-accent/50'
      }`}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-muted-foreground truncate">
          <SearchHighlight text={result.title} query={query} />
        </div>
        <div className="text-xs text-muted-foreground/60 mt-0.5 flex items-center gap-1.5">
          <span>{insightTypeKey ? t(insightTypeKey) : result.type.replace(/_/g, ' ')}</span>
          <span>·</span>
          <span className="truncate">{result.project_name}</span>
          <span>·</span>
          <span>{formatRelativeDate(result.created_at)}</span>
        </div>
        {result.snippet && (
          <div className="text-xs text-muted-foreground/50 mt-0.5 truncate">
            <SearchHighlight text={result.snippet} query={query} />
          </div>
        )}
      </div>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 mt-1" />
    </div>
  );
}
