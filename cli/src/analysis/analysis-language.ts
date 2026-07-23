import type { AnalysisLanguage, ClaudeInsightConfig } from '../types.js';
import { loadConfig } from '../utils/config.js';
import { classifyStoredUserMessage } from './message-format.js';

export type ResolvedAnalysisLanguage = Exclude<AnalysisLanguage, 'auto'>;

export interface AnalysisLanguageMessage {
  type: string;
  content: string;
}

export interface AnalysisLanguageContext {
  preference: AnalysisLanguage;
  messages: readonly AnalysisLanguageMessage[];
}

const VALID_ANALYSIS_LANGUAGES = new Set<AnalysisLanguage>(['auto', 'zh-CN', 'en-US']);

export function configuredAnalysisLanguage(
  config: ClaudeInsightConfig | null,
): AnalysisLanguage {
  const language = config?.dashboard?.analysisLanguage;
  return language && VALID_ANALYSIS_LANGUAGES.has(language) ? language : 'auto';
}

export function loadConfiguredAnalysisLanguage(): AnalysisLanguage {
  return configuredAnalysisLanguage(loadConfig());
}

export function resolveAnalysisLanguage(
  preference: AnalysisLanguage,
  messages: readonly AnalysisLanguageMessage[],
): ResolvedAnalysisLanguage {
  if (preference !== 'auto') return preference;

  let chineseTurns = 0;
  let otherLanguageTurns = 0;
  for (const message of messages) {
    if (
      message.type !== 'user'
      || classifyStoredUserMessage(message.content) !== 'human'
    ) {
      continue;
    }
    if (/\p{Script=Han}/u.test(message.content)) {
      chineseTurns++;
    } else if (/\p{Letter}/u.test(message.content)) {
      otherLanguageTurns++;
    }
  }
  return chineseTurns > otherLanguageTurns ? 'zh-CN' : 'en-US';
}

export function buildAnalysisLanguageInstruction(
  preference: AnalysisLanguage,
  messages: readonly AnalysisLanguageMessage[],
): string {
  const language = resolveAnalysisLanguage(preference, messages);
  const displayName = language === 'zh-CN'
    ? 'Simplified Chinese (zh-CN)'
    : 'English (en-US)';

  return `=== OUTPUT LANGUAGE ===
Write every user-visible prose field in ${displayName}.
Keep JSON keys, schema enum values, category IDs, attribution/severity/resolution/driver values, code identifiers, file paths, API names, commands, and quoted evidence in their original form.`;
}

export function appendAnalysisLanguageInstruction(
  instructions: string,
  context?: AnalysisLanguageContext,
): string {
  if (!context) return instructions;
  return `${instructions}\n\n${buildAnalysisLanguageInstruction(
    context.preference,
    context.messages,
  )}`;
}
