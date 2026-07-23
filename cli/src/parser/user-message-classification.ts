/**
 * Shared classification for textual `type: 'user'` payloads.
 *
 * Claude Code stores several protocol and UI artifacts as user messages. Both
 * ingestion-time metrics and later analysis must use this same policy so these
 * artifacts never become human conversation turns in one path but not another.
 */
export type UserMessageClass =
  | 'human'
  | 'tool-result'
  | 'task-notification'
  | 'skill-load'
  | 'auto-compact'
  | 'user-compact'
  | 'slash-command'
  | 'command-frame'
  | 'exit-command';

export type TextUserMessageClass = Exclude<UserMessageClass, 'tool-result'>;

/** Extract a slash command from either its XML frame or stored raw form. */
export function extractSlashCommandName(text: string): string | null {
  const xmlMatch = text.match(/<command-name>(\/[^<]+)<\/command-name>/);
  const trimmed = text.trim();
  const commandText = xmlMatch?.[1]
    ?? (/^\/[a-z]/.test(trimmed) && trimmed.split('\n').length <= 2 ? trimmed : null);
  return commandText ? commandText.trim().split(/\s+/)[0] : null;
}

/** Classify a textual user payload. Order matters: most specific checks first. */
export function classifyUserMessageText(text: string): TextUserMessageClass {
  if (text.startsWith('<task-notification>')) return 'task-notification';
  if (text.startsWith('Base directory for this skill:')) return 'skill-load';
  if (
    text.startsWith('This session is being continued')
    || text.startsWith('Here is a summary of our conversation')
  ) {
    return 'auto-compact';
  }

  const commandName = extractSlashCommandName(text);
  if (commandName === '/compact') return 'user-compact';
  if (commandName === '/exit' || commandName === '/quit') return 'exit-command';
  if (commandName !== null) return 'slash-command';

  if (
    text.startsWith('<local-command-caveat>')
    || text.startsWith('<local-command-stdout>')
  ) {
    return 'command-frame';
  }

  return 'human';
}
