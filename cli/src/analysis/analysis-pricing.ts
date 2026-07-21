import { PROVIDERS } from '../constants/llm-providers.js';
import { getModelPricing } from '../utils/pricing.js';

export interface AnalysisCostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export function calculateAnalysisCost(
  provider: string,
  model: string,
  usage: AnalysisCostUsage,
): number {
  if (provider === 'ollama' || provider === 'llamacpp') return 0;

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;

  if (provider === 'anthropic') {
    const pricing = getModelPricing(model);
    const total = (inputTokens / 1_000_000) * pricing.input
      + (outputTokens / 1_000_000) * pricing.output
      + (cacheCreationTokens / 1_000_000) * pricing.input * 1.25
      + (cacheReadTokens / 1_000_000) * pricing.input * 0.10;
    return Math.round(total * 1_000_000) / 1_000_000;
  }

  const providerInfo = PROVIDERS.find((entry) => entry.id === provider);
  const modelInfo = providerInfo?.models.find((entry) => entry.id === model);
  if (modelInfo?.inputCostPer1M == null || modelInfo.outputCostPer1M == null) return 0;

  const total = (inputTokens / 1_000_000) * modelInfo.inputCostPer1M
    + (outputTokens / 1_000_000) * modelInfo.outputCostPer1M
    + (provider === 'openai'
      ? (cacheReadTokens / 1_000_000) * modelInfo.inputCostPer1M * 0.5
      : 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}
