import { Link } from 'react-router';
import { formatDistanceToNow } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { MessageSquare, FileText, GitCommit, BookOpen, Target, Activity, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useLocale } from '@/i18n/LocaleProvider';
import { INSIGHT_TYPE_COLORS, SOURCE_TOOL_COLORS } from '@/lib/constants/colors';
import type { Session, Insight, InsightType } from '@/lib/types';

type FeedItem =
  | { kind: 'session'; session: Session; timestamp: Date }
  | { kind: 'insight'; insight: Insight; timestamp: Date };

interface ActivityFeedProps {
  sessions: Session[];
  insights: Insight[];
  limit?: number;
}

const insightTypeIcons: Record<InsightType, typeof FileText> = {
  summary: FileText,
  decision: GitCommit,
  learning: BookOpen,
  technique: BookOpen,
  prompt_quality: Target,
};

const insightTypeLabelKeys = {
  summary: 'dashboard.feed.summary',
  decision: 'dashboard.feed.decision',
  learning: 'dashboard.feed.learning',
  technique: 'dashboard.feed.learning',
  prompt_quality: 'dashboard.feed.promptQuality',
} as const;

export function ActivityFeed({ sessions, insights, limit = 7 }: ActivityFeedProps) {
  const { t } = useLocale();
  const feedItems: FeedItem[] = [
    ...sessions.map((s) => ({ kind: 'session' as const, session: s, timestamp: new Date(s.started_at) })),
    ...insights.map((i) => ({ kind: 'insight' as const, insight: i, timestamp: new Date(i.timestamp) })),
  ]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);

  if (feedItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-4 gap-1.5 text-center">
        <Activity className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t('dashboard.feed.emptyTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('dashboard.feed.emptyDescription')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-0 divide-y divide-border/55">
      {feedItems.map((item) =>
        item.kind === 'session' ? (
          <SessionFeedItem key={`s-${item.session.id}`} session={item.session} />
        ) : (
          <InsightFeedItem key={`i-${item.insight.id}`} insight={item.insight} />
        )
      )}
    </div>
  );
}

function SessionFeedItem({ session }: { session: Session }) {
  const { locale, t } = useLocale();
  const startedAt = new Date(session.started_at);
  const endedAt = new Date(session.ended_at);
  const durationMin = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000);
  const displayTitle = session.custom_title
    || session.generated_title
    || session.summary
    || t('dashboard.feed.untitledSession');

  return (
    <Link to={`/sessions?session=${session.id}`} className="block group">
      <div className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition-colors duration-150 hover:bg-muted/55">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/9 text-primary transition-colors group-hover:bg-primary/13">
          <MessageSquare className="h-4 w-4" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-1 text-sm font-medium leading-5 transition-colors group-hover:text-primary">
            {displayTitle}
          </p>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {session.source_tool && (
              <Badge
                variant="outline"
                className={`h-5 shrink-0 rounded-md px-1.5 text-[10px] capitalize ${SOURCE_TOOL_COLORS[session.source_tool] ?? 'bg-muted text-muted-foreground'}`}
              >
                {session.source_tool}
              </Badge>
            )}
            <span className="truncate">
              {t('dashboard.feed.sessionMeta', {
                messages: session.message_count,
                minutes: durationMin,
              })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden sm:inline">
            {formatDistanceToNow(startedAt, {
              addSuffix: true,
              locale: locale === 'zh-CN' ? zhCN : enUS,
            })}
          </span>
          <ChevronRight className="h-3.5 w-3.5" />
        </div>
      </div>
    </Link>
  );
}

function InsightFeedItem({ insight }: { insight: Insight }) {
  const { locale, t } = useLocale();
  const Icon = insightTypeIcons[insight.type];
  const colorClass = INSIGHT_TYPE_COLORS[insight.type];
  const label = t(insightTypeLabelKeys[insight.type]);

  return (
    <Link to={`/sessions?session=${insight.session_id}`} className="block group">
      <div className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition-colors duration-150 hover:bg-muted/55">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] transition-colors ${colorClass}`}>
          <Icon className="h-4 w-4" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-1 text-sm font-medium leading-5 transition-colors group-hover:text-primary">
            {insight.title}
          </p>
          <div className="mt-1">
            <Badge variant="outline" className={`h-5 shrink-0 rounded-md px-1.5 text-[10px] ${colorClass}`}>
              {label}
            </Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden sm:inline">
            {formatDistanceToNow(new Date(insight.timestamp), {
              addSuffix: true,
              locale: locale === 'zh-CN' ? zhCN : enUS,
            })}
          </span>
          <ChevronRight className="h-3.5 w-3.5" />
        </div>
      </div>
    </Link>
  );
}
