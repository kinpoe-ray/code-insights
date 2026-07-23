import { describe, expect, it } from 'vitest';
import { sanitizeMessageReferences } from '../message-references.js';
import type {
  AnalysisResponse,
  PromptQualityResponse,
  SQLiteMessageRow,
} from '../prompt-types.js';

function message(
  id: string,
  type: SQLiteMessageRow['type'],
  content: string,
): SQLiteMessageRow {
  return {
    id,
    session_id: 'session-1',
    type,
    content,
    thinking: null,
    tool_calls: '[]',
    tool_results: '[]',
    usage: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    parent_id: null,
  };
}

describe('sanitizeMessageReferences', () => {
  it('uses human-only turn bounds and preserves valid siblings', () => {
    const messages = [
      message('m1', 'user', 'First request'),
      message('m2', 'user', '/compact'),
      message('m3', 'assistant', 'First reply'),
      message('m4', 'user', 'Second request'),
    ];
    const sessionResponse: AnalysisResponse = {
      summary: { title: 'Summary', content: 'Content', bullets: [] },
      decisions: [{
        title: 'Decision',
        reasoning: 'Reason',
        evidence: [
          'User#0: valid',
          'User #1: safely normalized',
          'Assistant#0: valid',
          'User#2: out of range',
          'Assistant#1: out of range',
          'msg-1',
        ],
      }],
      learnings: [{
        title: 'Ungrounded learning',
        content: 'Must not be published without a real message reference.',
        evidence: ['User#2: out of range', 'msg-1'],
      }],
    };
    const promptQualityResponse: PromptQualityResponse = {
      efficiency_score: 80,
      message_overhead: 0,
      assessment: 'Assessment',
      findings: [
        {
          category: 'precise-request',
          type: 'strength',
          description: 'Valid',
          message_ref: 'User#0',
          impact: 'medium',
          confidence: 90,
        },
        {
          category: 'precise-request',
          type: 'strength',
          description: 'Normalized',
          message_ref: 'User #1: quoted prompt',
          impact: 'low',
          confidence: 80,
        },
        {
          category: 'vague-request',
          type: 'deficit',
          description: 'Out of range',
          message_ref: 'User#2',
          impact: 'low',
          confidence: 70,
        },
      ],
      takeaways: [
        {
          type: 'reinforce',
          category: 'precise-request',
          label: 'Malformed',
          message_ref: 'msg-1',
        },
        {
          type: 'reinforce',
          category: 'precise-request',
          label: 'Valid',
          message_ref: 'User#1',
        },
      ],
      dimension_scores: {
        context_provision: 80,
        request_specificity: 80,
        scope_management: 80,
        information_timing: 80,
        correction_quality: 80,
      },
    };

    const sanitized = sanitizeMessageReferences(
      sessionResponse,
      promptQualityResponse,
      messages,
    );

    expect(sanitized.sessionResponse.decisions[0].evidence).toEqual([
      'User#0: valid',
      'User#1: safely normalized',
      'Assistant#0: valid',
    ]);
    expect(sanitized.sessionResponse.learnings).toEqual([]);
    expect(sanitized.promptQualityResponse.findings.map(finding => ({
      description: finding.description,
      message_ref: finding.message_ref,
    }))).toEqual([
      { description: 'Valid', message_ref: 'User#0' },
      { description: 'Normalized', message_ref: 'User#1' },
    ]);
    expect(sanitized.promptQualityResponse.takeaways).toHaveLength(1);
    expect(sanitized.promptQualityResponse.takeaways[0].message_ref).toBe('User#1');
    expect(promptQualityResponse.findings).toHaveLength(3);
  });
});
