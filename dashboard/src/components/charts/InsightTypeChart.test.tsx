import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { InsightTypeChart } from './InsightTypeChart';

describe('InsightTypeChart', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('code-insights.locale', 'zh-CN');
  });

  it('renders chart labels in the selected language', () => {
    render(
      <LocaleProvider>
        <InsightTypeChart data={{ summary: 0, decision: 0, learning: 0, prompt_quality: 0 }} />
      </LocaleProvider>,
    );

    expect(screen.getByText('洞察类型')).toBeInTheDocument();
    expect(screen.getByText('暂无洞察')).toBeInTheDocument();
  });
});
