// LLM response parsing utilities.
// Extracted from prompts.ts — handles JSON extraction, repair, and validation.

import { jsonrepair } from 'jsonrepair';
import type {
  AnalysisResponse,
  ParseError,
  ParseResult,
  PromptQualityFinding,
  PromptQualityResponse,
  PromptQualityTakeaway,
} from './prompt-types.js';
import {
  CANONICAL_FRICTION_CATEGORIES,
  CANONICAL_PATTERN_CATEGORIES,
} from './prompt-constants.js';
import { normalizeFrictionCategory } from './friction-normalize.js';
import { normalizePatternCategory } from './pattern-normalize.js';
import { redactCredentialValues } from '../privacy/outbound-credential-guard.js';

type AnalysisFacets = NonNullable<AnalysisResponse['facets']>;
type FrictionPoint = AnalysisFacets['friction_points'][number];
type EffectivePattern = AnalysisFacets['effective_patterns'][number];

const FRICTION_CATEGORIES = new Set<string>(CANONICAL_FRICTION_CATEGORIES);
const FRICTION_ATTRIBUTIONS = new Set([
  'user-actionable',
  'ai-capability',
  'environmental',
]);
const FRICTION_SEVERITIES = new Set(['high', 'medium', 'low']);
const EFFECTIVE_PATTERN_CATEGORIES = new Set<string>(CANONICAL_PATTERN_CATEGORIES);
const EFFECTIVE_PATTERN_DRIVERS = new Set([
  'user-driven',
  'ai-driven',
  'collaborative',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function normalizeBoundedScore(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeNonNegativeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizePromptQualityTakeaway(value: unknown): PromptQualityTakeaway | undefined {
  if (
    !isRecord(value)
    || (value.type !== 'improve' && value.type !== 'reinforce')
    || !isNonEmptyString(value.category)
    || !isNonEmptyString(value.label)
    || !isNonEmptyString(value.message_ref)
  ) {
    return undefined;
  }

  return {
    type: value.type,
    category: value.category.trim(),
    label: value.label.trim(),
    message_ref: value.message_ref.trim(),
    ...(typeof value.original === 'string' && { original: value.original }),
    ...(typeof value.better_prompt === 'string' && { better_prompt: value.better_prompt }),
    ...(typeof value.why === 'string' && { why: value.why }),
    ...(typeof value.what_worked === 'string' && { what_worked: value.what_worked }),
    ...(typeof value.why_effective === 'string' && { why_effective: value.why_effective }),
  };
}

function normalizePromptQualityFinding(value: unknown): PromptQualityFinding | undefined {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.category)
    || (value.type !== 'deficit' && value.type !== 'strength')
    || !isNonEmptyString(value.description)
    || !isNonEmptyString(value.message_ref)
  ) {
    return undefined;
  }

  const impact = value.impact === 'high'
    || value.impact === 'medium'
    || value.impact === 'low'
    ? value.impact
    : 'medium';

  return {
    category: value.category.trim(),
    type: value.type,
    description: value.description.trim(),
    message_ref: value.message_ref.trim(),
    impact,
    confidence: normalizeBoundedScore(value.confidence, 50),
    ...(typeof value.suggested_improvement === 'string' && {
      suggested_improvement: value.suggested_improvement,
    }),
  };
}

function normalizeFrictionPoint(value: unknown): FrictionPoint | undefined {
  if (!isRecord(value) || typeof value.category !== 'string') return undefined;
  const category = normalizeFrictionCategory(value.category);
  if (
    !FRICTION_CATEGORIES.has(category)
    || typeof value.description !== 'string'
    || typeof value.severity !== 'string'
    || !FRICTION_SEVERITIES.has(value.severity)
    || typeof value.resolution !== 'string'
    || !isOptionalString(value._reasoning)
    || (
      value.attribution !== undefined
      && (
        typeof value.attribution !== 'string'
        || !FRICTION_ATTRIBUTIONS.has(value.attribution)
      )
    )
  ) {
    return undefined;
  }
  return { ...value, category } as unknown as FrictionPoint;
}

function normalizeEffectivePattern(value: unknown): EffectivePattern | undefined {
  if (!isRecord(value) || typeof value.category !== 'string') return undefined;
  const category = normalizePatternCategory(value.category);
  if (
    !EFFECTIVE_PATTERN_CATEGORIES.has(category)
    || typeof value.description !== 'string'
    || typeof value.confidence !== 'number'
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 100
    || !isOptionalString(value._reasoning)
    || (
      value.driver !== undefined
      && (
        typeof value.driver !== 'string'
        || !EFFECTIVE_PATTERN_DRIVERS.has(value.driver)
      )
    )
  ) {
    return undefined;
  }
  return { ...value, category } as unknown as EffectivePattern;
}

function buildResponsePreview(text: string, head = 200, tail = 200): string {
  if (text.length <= head + tail + 20) return text;
  return `${text.slice(0, head)}\n...[${text.length - head - tail} chars omitted]...\n${text.slice(-tail)}`;
}

export function extractJsonPayload(response: string): string | null {
  const tagged = response.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if (tagged?.[1]) return tagged[1].trim();
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  return jsonMatch ? jsonMatch[0] : null;
}

function extractPromptQualityJsonPayload(response: string): string | null {
  const tagged = response.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if (tagged?.[1]) return tagged[1].trim();

  const trimmed = response.trim();
  if (trimmed !== '') {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Fall through to root-aware extraction so prose-wrapped and repairable
      // object responses remain supported without unwrapping root arrays.
    }
  }

  let cursor = 0;
  let firstCandidate: string | null = null;
  let firstObjectCandidate: string | null = null;
  while (cursor < response.length) {
    const relativeStart = response.slice(cursor).search(/[\[{]/);
    if (relativeStart === -1) break;
    const start = cursor + relativeStart;
    const stack: string[] = [];
    let quote: '"' | "'" | null = null;
    let escaped = false;
    let end = -1;

    for (let index = start; index < response.length; index++) {
      const char = response[index];
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack.at(-1) !== expected) break;
        stack.pop();
        if (stack.length === 0) {
          end = index + 1;
          break;
        }
      }
    }

    if (end === -1) {
      const remainder = response.slice(start).trim();
      if (response[start] === '{') return remainder;
      return firstObjectCandidate ?? firstCandidate ?? remainder;
    }

    const candidate = response.slice(start, end);
    firstCandidate ??= candidate;
    if (response[start] === '{') firstObjectCandidate ??= candidate;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      cursor = end;
    }
  }

  return firstObjectCandidate ?? firstCandidate;
}

export function validateAnalysisFacets(value: unknown): AnalysisResponse['facets'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const facets = value as Record<string, unknown>;
  if (typeof facets.outcome_satisfaction !== 'string' || facets.outcome_satisfaction.trim() === '') {
    return undefined;
  }
  if (facets.workflow_pattern !== null && typeof facets.workflow_pattern !== 'string') {
    return undefined;
  }
  if (typeof facets.had_course_correction !== 'boolean') {
    return undefined;
  }
  if (facets.course_correction_reason !== null && typeof facets.course_correction_reason !== 'string') {
    return undefined;
  }
  if (
    typeof facets.iteration_count !== 'number'
    || !Number.isInteger(facets.iteration_count)
    || facets.iteration_count < 0
  ) {
    return undefined;
  }
  if (!Array.isArray(facets.friction_points) || !Array.isArray(facets.effective_patterns)) {
    return undefined;
  }

  const frictionPoints = facets.friction_points
    .map(normalizeFrictionPoint)
    .filter((point): point is FrictionPoint => point !== undefined);
  const effectivePatterns = facets.effective_patterns
    .map(normalizeEffectivePattern)
    .filter((pattern): pattern is EffectivePattern => pattern !== undefined);

  return redactCredentialValues({
    ...facets,
    friction_points: frictionPoints,
    effective_patterns: effectivePatterns,
  } as unknown as NonNullable<AnalysisResponse['facets']>);
}

/**
 * Parse the LLM response into structured insights.
 */
export function parseAnalysisResponse(response: string): ParseResult<AnalysisResponse> {
  const response_length = response.length;

  const preview = buildResponsePreview(response);

  const jsonPayload = extractJsonPayload(response);
  if (!jsonPayload) {
    console.error('No JSON found in analysis response');
    return {
      success: false,
      error: { error_type: 'no_json_found', error_message: 'No JSON found in analysis response', response_length, response_preview: preview },
    };
  }

  let parsed: AnalysisResponse;
  try {
    parsed = JSON.parse(jsonPayload) as AnalysisResponse;
  } catch {
    // Attempt repair — handles trailing commas, unclosed braces, truncated output
    try {
      parsed = JSON.parse(jsonrepair(jsonPayload)) as AnalysisResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to parse analysis response (after jsonrepair):', err);
      return {
        success: false,
        error: { error_type: 'json_parse_error', error_message: msg, response_length, response_preview: preview },
      };
    }
  }

  if (!parsed.summary || typeof parsed.summary.title !== 'string') {
    console.error('Invalid analysis response structure');
    return {
      success: false,
      error: { error_type: 'invalid_structure', error_message: 'Missing or invalid summary field', response_length, response_preview: preview },
    };
  }

  // Guard against LLM returning non-array values (e.g. "decisions": "none").
  // || [] alone won't catch truthy non-arrays — Array.isArray is required.
  parsed.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  parsed.learnings = Array.isArray(parsed.learnings) ? parsed.learnings : [];

  // Invalid optional facets must not contaminate an otherwise usable analysis.
  // The shared validator also preserves the existing friction-point cleanup.
  if (parsed.facets !== undefined) {
    const facets = validateAnalysisFacets(parsed.facets);
    if (facets) {
      parsed.facets = facets;
    } else {
      delete parsed.facets;
    }
  }

  // Treat model output as another untrusted boundary. A provider must not be
  // able to reintroduce credential-shaped strings into durable insights or
  // facets, even when it echoes or hallucinates sensitive-looking content.
  parsed = redactCredentialValues(parsed);

  // Observability: two-tier tooling-limitation monitor.
  // Tier 1: _reasoning contains misclassification signals NOT in a negation context → likely wrong category.
  // Tier 2: no conflicting signals (or signal was negated) → generic reminder to verify.
  // Re-evaluate after ~30 sessions with improved FRICTION_CLASSIFICATION_GUIDANCE.
  if (parsed.facets?.friction_points?.some(fp => fp.category === 'tooling-limitation')) {
    // Expanded regex covers both literal terms and GPT-4o paraphrasing patterns
    const MISCLASS_SIGNALS = /rate.?limit|throttl|quota.?exceed|crash|fail.{0,10}unexpect|lost.?state|context.{0,10}(?:drop|lost|unavail)|wrong.?tool|different.?(?:approach|method)|(?:didn.t|did not|unaware).{0,10}(?:know|capabil)|(?:older|previous).?version|used to (?:work|be)|behavio.?r.?change/i;
    const NEGATION_CONTEXT = /\bnot\b|\bnor\b|\bisn.t\b|\bwasn.t\b|\brule[d]? out\b|\brejected?\b|\beliminated?\b|\breclassif/i;
    const toolingFps = parsed.facets.friction_points.filter(fp => fp.category === 'tooling-limitation');
    for (const fp of toolingFps) {
      if (!fp._reasoning) {
        console.warn('[friction-monitor] LLM classified friction as "tooling-limitation" without _reasoning — cannot verify');
        continue;
      }
      const matchResult = fp._reasoning.match(MISCLASS_SIGNALS);
      if (matchResult) {
        // Check if the signal appears in a negation context (model correctly eliminating the alternative)
        const matchIdx = fp._reasoning.search(MISCLASS_SIGNALS);
        const preceding = fp._reasoning.slice(Math.max(0, matchIdx - 40), matchIdx);
        if (!NEGATION_CONTEXT.test(preceding)) {
          console.warn(`[friction-monitor] Likely misclassification: "tooling-limitation" with reasoning mentioning "${matchResult[0]}" — review category`);
        }
        // If negated, the model correctly considered and rejected the alternative — no warning
      } else {
        console.warn('[friction-monitor] LLM classified friction as "tooling-limitation" — verify genuine tool limitation');
      }
    }
  }

  // Observability: warn when LLM returns effective_pattern without category or driver field,
  // or with an unrecognized driver value.
  // Catches models that ignore the classification instructions (especially smaller Ollama models).
  // Remove after confirming classification quality over ~20 new sessions.
  if (parsed.facets?.effective_patterns?.some(ep => !ep.category)) {
    console.warn('[pattern-monitor] LLM returned effective_pattern without category field');
  }
  if (parsed.facets?.effective_patterns?.some(ep => !ep.driver)) {
    console.warn('[pattern-monitor] LLM returned effective_pattern without driver field — driver classification may be incomplete');
  }
  const VALID_DRIVERS = new Set(['user-driven', 'ai-driven', 'collaborative']);
  if (parsed.facets?.effective_patterns?.some(ep => ep.driver && !VALID_DRIVERS.has(ep.driver))) {
    console.warn('[pattern-monitor] LLM returned unexpected driver value — check classification quality');
  }

  // Validation: check for missing _reasoning CoT scratchpad fields.
  // These fields ensure the model walks through the attribution/driver decision trees
  // before committing to classification values.
  // (Monitoring period complete — warn calls removed after confirming CoT compliance)
  if (parsed.facets?.friction_points?.some(fp => !fp._reasoning)) {
    // Missing _reasoning: classification may lack decision-tree rigor
  }
  if (parsed.facets?.effective_patterns?.some(ep => !ep._reasoning)) {
    // Missing _reasoning: classification may lack decision-tree rigor
  }

  return { success: true, data: parsed };
}

export function parsePromptQualityResponse(response: string): ParseResult<PromptQualityResponse> {
  const response_length = response.length;
  const preview = buildResponsePreview(response);
  const invalidStructure = (message: string): ParseResult<PromptQualityResponse> => {
    console.error(`Invalid prompt quality response: ${message}`);
    return {
      success: false,
      error: {
        error_type: 'invalid_structure',
        error_message: message,
        response_length,
        response_preview: preview,
      },
    };
  };

  const jsonPayload = extractPromptQualityJsonPayload(response);
  if (!jsonPayload) {
    console.error('No JSON found in prompt quality response');
    return {
      success: false,
      error: { error_type: 'no_json_found', error_message: 'No JSON found in prompt quality response', response_length, response_preview: preview },
    };
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(jsonPayload) as unknown;
  } catch {
    try {
      parsedValue = JSON.parse(jsonrepair(jsonPayload)) as unknown;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to parse prompt quality response (after jsonrepair):', msg);
      return {
        success: false,
        error: { error_type: 'json_parse_error', error_message: msg, response_length, response_preview: preview },
      };
    }
  }

  if (
    !isRecord(parsedValue)
    || typeof parsedValue.efficiency_score !== 'number'
    || !Number.isFinite(parsedValue.efficiency_score)
  ) {
    return invalidStructure('Missing or invalid efficiency_score field');
  }
  const dimensionScores = isRecord(parsedValue.dimension_scores)
    ? parsedValue.dimension_scores
    : {};
  const parsed: PromptQualityResponse = {
    efficiency_score: normalizeBoundedScore(parsedValue.efficiency_score, 0),
    message_overhead: normalizeNonNegativeCount(parsedValue.message_overhead),
    assessment: typeof parsedValue.assessment === 'string' ? parsedValue.assessment : '',
    // Guard against LLM returning non-array values (e.g. "findings": "none").
    // Malformed children are dropped while valid siblings remain usable.
    takeaways: (Array.isArray(parsedValue.takeaways) ? parsedValue.takeaways : [])
      .map(normalizePromptQualityTakeaway)
      .filter((takeaway): takeaway is PromptQualityTakeaway => takeaway !== undefined)
      .slice(0, 4),
    findings: (Array.isArray(parsedValue.findings) ? parsedValue.findings : [])
      .map(normalizePromptQualityFinding)
      .filter((finding): finding is PromptQualityFinding => finding !== undefined)
      .slice(0, 8),
    dimension_scores: {
      context_provision: normalizeBoundedScore(dimensionScores.context_provision, 50),
      request_specificity: normalizeBoundedScore(dimensionScores.request_specificity, 50),
      scope_management: normalizeBoundedScore(dimensionScores.scope_management, 50),
      information_timing: normalizeBoundedScore(dimensionScores.information_timing, 50),
      correction_quality: normalizeBoundedScore(dimensionScores.correction_quality, 50),
    },
  };

  // Validation: check for missing category or unexpected type values in findings.
  // (Monitoring period complete — warn calls removed after confirming classification quality)
  if (parsed.findings.some(f => !f.category)) {
    // Finding missing category field
  }

  if (parsed.findings.some(f => f.type && f.type !== 'deficit' && f.type !== 'strength')) {
    // Finding has unexpected type value — expected deficit or strength
  }

  return { success: true, data: redactCredentialValues(parsed) };
}
