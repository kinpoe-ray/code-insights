import { Badge } from '@/components/ui/badge';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SESSION_CHARACTER_COLORS, SOURCE_TOOL_COLORS } from '@/lib/constants/colors';
import { parseJsonField } from '@/lib/types';
import type { Session } from '@/lib/types';
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

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  'codex-cli': 'Codex CLI',
  'copilot-cli': 'Copilot CLI',
  copilot: 'Copilot',
};

export function SessionIdentityStrip({ session }: { session: Session }) {
  const { t, formatDate } = useLocale();
  const startedAt = new Date(session.started_at);
  const models = parseJsonField<unknown>(session.models_used, []);
  const modelList = Array.isArray(models) ? models.filter((model): model is string => typeof model === 'string') : [];
  const model = session.primary_model || modelList[0] || t('sessions.detail.notRecorded');
  const mode = session.session_character
    ? t(CHARACTER_LABEL_KEYS[session.session_character])
    : t('sessions.detail.notRecorded');
  const source = session.source_tool
    ? SOURCE_LABELS[session.source_tool] ?? session.source_tool
    : t('sessions.detail.notRecorded');

  return (
    <div>
      <div
        className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6"
        data-testid="session-identity-strip"
      >
        <IdentityCell
          label={t('sessions.detail.identity.time')}
          value={formatDate(startedAt, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        />
        <IdentityCell label={t('sessions.detail.identity.channel')}>
          <Badge
            variant="outline"
            className={cn(
              'max-w-full px-2 py-0.5 text-xs font-normal',
              SOURCE_TOOL_COLORS[session.source_tool ?? ''] ?? 'bg-muted text-muted-foreground'
            )}
          >
            <span className="truncate">{source}</span>
          </Badge>
        </IdentityCell>
        <IdentityCell label={t('sessions.detail.identity.mode')}>
          {session.session_character ? (
            <Badge
              variant="outline"
              className={cn(
                'max-w-full px-2 py-0.5 text-xs font-normal',
                SESSION_CHARACTER_COLORS[session.session_character]
              )}
            >
              <span className="truncate">{mode}</span>
            </Badge>
          ) : (
            <span className="truncate text-sm font-medium">{mode}</span>
          )}
        </IdentityCell>
        <IdentityCell label={t('sessions.detail.identity.project')} value={session.project_name} />
        <IdentityCell label={t('sessions.detail.identity.model')} value={model} />
        <IdentityCell
          label={t('sessions.detail.identity.branch')}
          value={session.git_branch || t('sessions.detail.notRecorded')}
        />
      </div>
    </div>
  );
}

function IdentityCell({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/10 px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 min-h-5 min-w-0" title={value}>
        {children ?? <span className="block truncate text-sm font-medium">{value}</span>}
      </div>
    </div>
  );
}
