import { describe, expect, it } from 'vitest';
import type { SessionListSignal } from '@/lib/types';
import {
  getReviewPresetCounts,
  matchesReviewPreset,
} from './SessionOnboarding';

const signals: SessionListSignal[] = [
  {
    session_id: 'partial',
    insight_counts: { summary: 1 },
    outcome: 'partial',
    prompt_quality_score: 82,
    is_analyzed: true,
  },
  {
    session_id: 'blocked',
    insight_counts: { summary: 1 },
    outcome: 'blocked',
    prompt_quality_score: null,
    is_analyzed: true,
  },
  {
    session_id: 'low-prompt',
    insight_counts: { summary: 1, prompt_quality: 1 },
    outcome: 'success',
    prompt_quality_score: 64,
    is_analyzed: true,
  },
  {
    session_id: 'unanalyzed',
    insight_counts: {},
    outcome: null,
    prompt_quality_score: null,
    is_analyzed: false,
  },
];

describe('session review presets', () => {
  it('classifies review-worthy sessions without treating unanalyzed sessions as reviewed', () => {
    const sessions = signals.map((signal) => ({ id: signal.session_id }));

    expect(getReviewPresetCounts(sessions, signals)).toEqual({
      'needs-review': 3,
      blocked: 1,
      'low-prompt': 1,
    });
    expect(matchesReviewPreset(signals[3], 'needs-review')).toBe(false);
    expect(matchesReviewPreset(undefined, 'all')).toBe(true);
  });
});
