import { parseJsonField } from '@/lib/types';
import type { Session } from '@/lib/types';
import { useLocale } from '@/i18n/LocaleProvider';

const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  'codex-cli': 'Codex CLI',
  'copilot-cli': 'Copilot CLI',
  copilot: 'Copilot',
};

export function SessionMetadataPanel({ session }: { session: Session }) {
  const { t, formatDate } = useLocale();
  const modelsValue = parseJsonField<unknown>(session.models_used, []);
  const models = Array.isArray(modelsValue)
    ? modelsValue.filter((model): model is string => typeof model === 'string')
    : [];
  const commandsValue = parseJsonField<unknown>(session.slash_commands, []);
  const commands = Array.isArray(commandsValue)
    ? commandsValue.filter((command): command is string => typeof command === 'string')
    : [];
  const dateOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  };
  const fallback = t('sessions.detail.notRecorded');

  const groups = [
    {
      title: t('sessions.detail.metadata.identity'),
      fields: [
        [t('sessions.detail.metadata.sessionId'), session.id],
        [t('sessions.detail.identity.channel'), session.source_tool ? SOURCE_LABELS[session.source_tool] ?? session.source_tool : fallback],
        [t('sessions.detail.identity.project'), session.project_name],
        [t('sessions.detail.metadata.projectPath'), session.project_path],
        [t('sessions.detail.identity.branch'), session.git_branch || fallback],
        [t('sessions.detail.metadata.gitRemote'), session.git_remote_url || fallback],
      ],
    },
    {
      title: t('sessions.detail.metadata.runtime'),
      fields: [
        [t('sessions.detail.metadata.startedAt'), formatDate(new Date(session.started_at), dateOptions)],
        [t('sessions.detail.metadata.endedAt'), formatDate(new Date(session.ended_at), dateOptions)],
        [t('sessions.detail.identity.model'), session.primary_model || models.join(', ') || fallback],
        [t('sessions.detail.metadata.modelsUsed'), models.join(', ') || fallback],
        [t('sessions.detail.metadata.clientVersion'), session.claude_version || fallback],
        [t('sessions.detail.metadata.usageSource'), session.usage_source || fallback],
      ],
    },
    {
      title: t('sessions.detail.metadata.activity'),
      fields: [
        [t('sessions.vitals.messages'), String(session.message_count)],
        [t('sessions.detail.metadata.userMessages'), String(session.user_message_count)],
        [t('sessions.detail.metadata.assistantMessages'), String(session.assistant_message_count)],
        [t('sessions.detail.metadata.toolCalls'), String(session.tool_call_count)],
        [t('sessions.detail.metadata.compacts'), String(session.compact_count)],
        [t('sessions.detail.metadata.autoCompacts'), String(session.auto_compact_count)],
        [t('sessions.detail.metadata.slashCommands'), commands.join(', ') || fallback],
      ],
    },
    {
      title: t('sessions.detail.metadata.device'),
      fields: [
        [t('sessions.detail.metadata.deviceName'), session.device_hostname || fallback],
        [t('sessions.detail.metadata.platform'), session.device_platform || fallback],
        [t('sessions.detail.metadata.deviceId'), session.device_id || fallback],
        [t('sessions.detail.metadata.syncedAt'), formatDate(new Date(session.synced_at), dateOptions)],
      ],
    },
  ] as const;

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="mb-2 text-sm font-semibold">{group.title}</h3>
          <dl className="grid grid-cols-1 overflow-hidden rounded-lg border sm:grid-cols-2">
            {group.fields.map(([label, value]) => (
              <div
                key={label}
                className="min-w-0 border-b px-4 py-3 last:border-b-0 sm:odd:border-r sm:[&:nth-last-child(-n+2)]:border-b-0"
              >
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {label}
                </dt>
                <dd className="mt-1 break-words font-mono text-xs text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
