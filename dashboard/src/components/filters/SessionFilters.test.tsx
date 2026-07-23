import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { SaveFilterPopover } from './SaveFilterPopover';
import { SavedFiltersDropdown } from './SavedFiltersDropdown';
import { SourceToolSelect } from './SourceToolSelect';

function LanguageSwitch() {
  const { setLocale } = useLocale();
  return (
    <button data-testid="language-switch" type="button" onClick={() => setLocale('zh-CN')}>
      switch
    </button>
  );
}

describe('Session filter language', () => {
  it('localizes filter controls without changing stored filter values', () => {
    localStorage.setItem('code-insights.locale', 'en-US');
    const onSave = vi.fn();
    const onSourceChange = vi.fn();

    render(
      <LocaleProvider>
        <LanguageSwitch />
        <SaveFilterPopover
          activeFilters={{ q: 'needle', source: 'codex-cli' }}
          defaultFilterValues={{ q: '', source: 'all' }}
          onSave={onSave}
        />
        <SavedFiltersDropdown savedFilters={[]} onApply={vi.fn()} onDelete={vi.fn()} />
        <SourceToolSelect value="all" onValueChange={onSourceChange} />
      </LocaleProvider>,
    );

    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('All Sources')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('language-switch'));

    expect(screen.getByText('已保存')).toBeInTheDocument();
    expect(screen.getByText('全部来源')).toBeInTheDocument();
    fireEvent.click(screen.getByText('保存'));
    expect(screen.getByText('保存当前筛选')).toBeInTheDocument();
    expect(screen.getByText('名称')).toBeInTheDocument();
    expect(screen.getByDisplayValue('needle / codex-cli')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(onSourceChange).not.toHaveBeenCalled();
  });
});
