import type { ContentBlock } from './prompt-types.js';

export type { ContentBlock };

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface LLMTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage?: LLMTokenUsage;
}

export interface ChatOptions {
  signal?: AbortSignal;
  temperature?: number;
  responseFormat?: 'json' | 'text';
}

export interface LLMCapabilities {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  supportsContentBlocks: boolean;
  /**
   * Conservative token allowance for the provider's serialized request
   * envelope. Text token estimates alone omit roles, message delimiters and
   * structured content-block metadata, so every adapter declares this budget.
   */
  requestOverhead: {
    baseTokens: number;
    perMessageTokens: number;
    perContentBlockTokens: number;
  };
}

export interface LLMClient {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: LLMCapabilities;
  /**
   * Synchronously apply the final outbound policy to a complete request.
   *
   * Implementations must be deterministic, idempotent, shape-preserving and
   * non-mutating. AnalysisEngine calls this before token budgeting/chunking;
   * chat() may call it again as a defense-in-depth boundary.
   */
  prepareMessages(messages: LLMMessage[]): LLMMessage[];
  chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse>;
  estimateTokens(text: string): number;
}

export function flattenContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.map((block) => block.text).join('');
}

/**
 * Estimate the final provider request payload, including both content and the
 * adapter-declared serialization envelope.
 */
export function estimateRequestTokens(client: LLMClient, messages: LLMMessage[]): number {
  const overhead = client.capabilities.requestOverhead;
  let total = overhead.baseTokens;
  for (const message of messages) {
    total += overhead.perMessageTokens;
    if (typeof message.content === 'string') {
      total += client.estimateTokens(message.content);
    } else {
      total += message.content.length * overhead.perContentBlockTokens;
      for (const block of message.content) {
        total += client.estimateTokens(block.text);
      }
    }
  }
  return total;
}

export function getRequestTokenBudget(client: LLMClient): number {
  const {
    contextWindowTokens,
    reservedOutputTokens,
    safetyMarginTokens,
  } = client.capabilities;
  return Math.max(1, contextWindowTokens - reservedOutputTokens - safetyMarginTokens);
}

export interface BoundedPreparedRequest {
  messages: LLMMessage[];
  truncated: boolean;
}

/**
 * Prepare a complete request before applying a conversation-size limit.
 *
 * The first content block of the first non-system message is the cacheable
 * conversation block used by configured analysis providers. Preparing the
 * complete request first ensures credential replacement expansion and fixed
 * system/instruction overhead are included in the final token budget.
 */
export function prepareBoundedConversationRequest(
  client: LLMClient,
  messages: LLMMessage[],
  truncationMarker = '\n\n[... conversation truncated for analysis ...]',
): BoundedPreparedRequest | null {
  const prepared = client.prepareMessages(messages);
  const conversationMessageIndex = prepared.findIndex(
    message => message.role !== 'system'
      && Array.isArray(message.content)
      && message.content.length > 0,
  );
  const conversationMessage = prepared[conversationMessageIndex];
  if (
    conversationMessageIndex < 0
    || !conversationMessage
    || !Array.isArray(conversationMessage.content)
    || !conversationMessage.content[0]
  ) {
    throw new Error('Prepared analysis request is missing its conversation block.');
  }

  const budget = getRequestTokenBudget(client);
  if (estimateRequestTokens(client, prepared) <= budget) {
    return { messages: prepared, truncated: false };
  }

  const conversationText = conversationMessage.content[0].text;
  const buildCandidate = (text: string): LLMMessage[] => prepared.map((message, messageIndex) => {
    if (messageIndex !== conversationMessageIndex || !Array.isArray(message.content)) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((block, blockIndex) => (
        blockIndex === 0 ? { ...block, text } : block
      )),
    };
  });

  let low = 0;
  let high = conversationText.length;
  let best: LLMMessage[] | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildCandidate(
      `${conversationText.slice(0, middle)}${truncationMarker}`,
    );
    if (estimateRequestTokens(client, candidate) <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best ? { messages: best, truncated: true } : null;
}

export function defaultLLMCapabilities(provider: string): LLMCapabilities {
  if (provider === 'llamacpp' || provider === 'ollama') {
    return {
      contextWindowTokens: 16_384,
      reservedOutputTokens: 4_096,
      safetyMarginTokens: 1_024,
      supportsContentBlocks: false,
      requestOverhead: {
        baseTokens: 3,
        perMessageTokens: 4,
        perContentBlockTokens: 2,
      },
    };
  }

  return {
    contextWindowTokens: 100_000,
    reservedOutputTokens: 8_192,
    safetyMarginTokens: 11_808,
    supportsContentBlocks: provider === 'anthropic',
    requestOverhead: {
      baseTokens: 3,
      perMessageTokens: 4,
      perContentBlockTokens: 2,
    },
  };
}
