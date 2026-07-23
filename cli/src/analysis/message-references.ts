import { classifyStoredUserMessage } from './message-format.js';
import type {
  AnalysisResponse,
  PromptQualityResponse,
  SQLiteMessageRow,
} from './prompt-types.js';

interface ReferenceBounds {
  userCount: number;
  assistantCount: number;
}

function getReferenceBounds(messages: SQLiteMessageRow[]): ReferenceBounds {
  let userCount = 0;
  let assistantCount = 0;

  for (const message of messages) {
    if (
      message.type === 'user'
      && classifyStoredUserMessage(message.content) === 'human'
    ) {
      userCount++;
    } else if (message.type === 'assistant') {
      assistantCount++;
    }
  }

  return { userCount, assistantCount };
}

function isIndexInRange(rawIndex: string, count: number): boolean {
  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && index < count;
}

function normalizeEvidenceReference(
  value: unknown,
  bounds: ReferenceBounds,
): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(User|Assistant)\s*#\s*(\d+)(?::([\s\S]*))?$/.exec(value.trim());
  if (!match) return null;

  const role = match[1];
  const count = role === 'User' ? bounds.userCount : bounds.assistantCount;
  if (!isIndexInRange(match[2], count)) return null;

  return `${role}#${Number(match[2])}${match[3] === undefined ? '' : `:${match[3]}`}`;
}

function normalizePromptQualityReference(
  value: unknown,
  bounds: ReferenceBounds,
): string | null {
  if (typeof value !== 'string') return null;
  const match = /^User\s*#\s*(\d+)(?::[\s\S]*)?$/.exec(value.trim());
  if (!match || !isIndexInRange(match[1], bounds.userCount)) return null;
  return `User#${Number(match[1])}`;
}

/**
 * Validate LLM references against the exact conversation snapshot being
 * published. Invalid prompt-quality children are removed. Decisions and
 * learnings without any valid evidence are not publishable; valid siblings
 * remain unchanged.
 */
export function sanitizeMessageReferences(
  sessionResponse: AnalysisResponse,
  promptQualityResponse: PromptQualityResponse,
  messages: SQLiteMessageRow[],
): {
  sessionResponse: AnalysisResponse;
  promptQualityResponse: PromptQualityResponse;
} {
  return {
    sessionResponse: sanitizeSessionMessageReferences(sessionResponse, messages),
    promptQualityResponse: sanitizePromptQualityMessageReferences(
      promptQualityResponse,
      messages,
    ),
  };
}

export function sanitizeSessionMessageReferences(
  response: AnalysisResponse,
  messages: SQLiteMessageRow[],
): AnalysisResponse {
  const bounds = getReferenceBounds(messages);
  const validEvidence = (evidence: unknown): string[] => (
    Array.isArray(evidence)
      ? evidence
        .map(reference => normalizeEvidenceReference(reference, bounds))
        .filter((reference): reference is string => reference !== null)
      : []
  );

  return {
    ...response,
    decisions: (response.decisions ?? []).flatMap(decision => {
      const evidence = validEvidence(decision.evidence);
      return evidence.length === 0 ? [] : [{ ...decision, evidence }];
    }),
    learnings: (response.learnings ?? []).flatMap(learning => {
      const evidence = validEvidence(learning.evidence);
      return evidence.length === 0 ? [] : [{ ...learning, evidence }];
    }),
  };
}

export function sanitizePromptQualityMessageReferences(
  response: PromptQualityResponse,
  messages: SQLiteMessageRow[],
): PromptQualityResponse {
  const bounds = getReferenceBounds(messages);
  return {
    ...response,
    findings: (response.findings ?? []).flatMap(finding => {
      const messageRef = normalizePromptQualityReference(finding?.message_ref, bounds);
      return messageRef === null ? [] : [{ ...finding, message_ref: messageRef }];
    }),
    takeaways: (response.takeaways ?? []).flatMap(takeaway => {
      const messageRef = normalizePromptQualityReference(takeaway?.message_ref, bounds);
      return messageRef === null ? [] : [{ ...takeaway, message_ref: messageRef }];
    }),
  };
}
