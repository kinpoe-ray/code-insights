import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { InsightTypePills } from './InsightTypePills';

describe('InsightTypePills', () => {
  it('presents legacy technique rows as one learning filter', () => {
    const onChange = vi.fn();
    render(
      <LocaleProvider>
        <InsightTypePills activeTypes={[]} onChange={onChange} />
      </LocaleProvider>,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: 'Learnings' }));
    expect(onChange).toHaveBeenCalledWith(['learning', 'technique']);
  });
});
