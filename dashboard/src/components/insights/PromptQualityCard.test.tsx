import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import type { Insight } from '@/lib/types';
import { PromptQualityCard } from './PromptQualityCard';

const promptQualityInsight: Insight = {
  id: 'prompt-quality-1',
  session_id: 'session-1',
  project_id: 'project-1',
  project_name: 'Stable Project',
  type: 'prompt_quality',
  title: 'Prompt quality',
  content: 'The request was mostly clear.',
  summary: 'A useful prompt review.',
  bullets: '[]',
  confidence: 0.9,
  source: 'llm',
  metadata: JSON.stringify({
    efficiency_score: 75,
    message_overhead: 2,
    takeaways: [{
      type: 'improve',
      category: 'missing-context',
      label: 'Add the runtime version.',
      message_ref: 'msg-1',
      original: 'Please fix it.',
      better_prompt: 'Please fix it on Node 24.',
      why: 'The runtime changes the answer.',
    }],
    findings: [{
      category: 'missing-context',
      type: 'deficit',
      description: 'The runtime version was omitted.',
      message_ref: 'msg-1',
      impact: 'high',
      confidence: 0.9,
      suggested_improvement: 'Name the runtime up front.',
    }],
    dimension_scores: {
      context_provision: 60,
      request_specificity: 80,
      scope_management: 70,
      information_timing: 65,
      correction_quality: 90,
    },
  }),
  timestamp: '2026-07-22T08:00:00.000Z',
  created_at: '2026-07-22T08:00:00.000Z',
  scope: 'session',
  analysis_version: 'test',
  linked_insight_ids: null,
};

function LanguageSwitch() {
  const { setLocale } = useLocale();
  return <button type="button" onClick={() => setLocale('zh-CN')}>switch</button>;
}

describe('Prompt quality card language', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'en-US');
  });

  it('translates analysis labels without translating model-generated findings', () => {
    render(
      <LocaleProvider>
        <LanguageSwitch />
        <PromptQualityCard insight={promptQualityInsight} />
      </LocaleProvider>,
    );

    expect(screen.getByText('Prompt Quality Analysis')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getAllByText('Missing Context').length).toBeGreaterThan(0);
    expect(screen.getByText('Dimension Scores')).toBeInTheDocument();
    expect(screen.getByText('The runtime version was omitted.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    expect(screen.getByText('提示词质量分析')).toBeInTheDocument();
    expect(screen.getByText('良好')).toBeInTheDocument();
    expect(screen.getAllByText('缺少上下文').length).toBeGreaterThan(0);
    expect(screen.getByText('维度得分')).toBeInTheDocument();
    expect(screen.getByText('上下文提供')).toBeInTheDocument();
    expect(screen.getByText('The runtime version was omitted.')).toBeInTheDocument();
  });
});
