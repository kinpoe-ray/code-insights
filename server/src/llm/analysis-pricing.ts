// Compatibility export for server callers. The implementation is shared with
// the CLI-core AnalysisEngine so every entry point uses one pricing policy.

export {
  calculateAnalysisCost,
  type AnalysisCostUsage,
} from '@code-insights/cli/analysis/analysis-pricing';

export const PRICING_LAST_UPDATED = '2026-03-15';
