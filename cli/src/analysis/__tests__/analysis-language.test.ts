import { describe, expect, it } from 'vitest';
import {
  buildAnalysisLanguageInstruction,
  configuredAnalysisLanguage,
  resolveAnalysisLanguage,
} from '../analysis-language.js';

describe('analysis output language', () => {
  const user = (content: string) => ({ type: 'user', content });

  it('uses an explicitly selected Chinese output language', () => {
    const instruction = buildAnalysisLanguageInstruction('zh-CN', [
      user('Please fix the dashboard.'),
    ]);

    expect(instruction).toContain('Simplified Chinese (zh-CN)');
    expect(instruction).toContain('Keep JSON keys, schema enum values, category IDs');
    expect(instruction).toContain('quoted evidence in their original form');
  });

  it('uses an explicitly selected English output language', () => {
    expect(buildAnalysisLanguageInstruction('en-US', [user('请修复 dashboard。')]))
      .toContain('English (en-US)');
  });

  it('follows the dominant human conversation language in auto mode', () => {
    expect(resolveAnalysisLanguage('auto', [
      user('请检查这个问题。'),
      user('可以，继续修复。'),
      user('Run the tests too.'),
    ])).toBe('zh-CN');
  });

  it('ignores stored tool results when detecting auto language', () => {
    expect(resolveAnalysisLanguage('auto', [
      user('[{"type":"tool_result","content":"大量中文输出"}]'),
      user('Please keep the final analysis concise.'),
    ])).toBe('en-US');
  });

  it('ignores every stored system artifact when detecting auto language', () => {
    expect(resolveAnalysisLanguage('auto', [
      user('<task-notification>中文任务通知</task-notification>'),
      user('Base directory for this skill: /大量/中文/路径'),
      user('<local-command-caveat>大量中文提示</local-command-caveat>'),
      user('<local-command-stdout>大量中文输出</local-command-stdout>'),
      user('<command-name>/plan 大量中文参数</command-name>'),
      user('This session is being continued 大量中文摘要'),
      user('Here is a summary of our conversation 大量中文摘要'),
      user('/review 大量中文参数'),
      user('Please keep the final analysis concise.'),
    ])).toBe('en-US');
  });

  it('defaults missing configuration to auto', () => {
    expect(configuredAnalysisLanguage(null)).toBe('auto');
    expect(configuredAnalysisLanguage({
      sync: { claudeDir: '', excludeProjects: [] },
      dashboard: { analysisLanguage: 'zh-CN' },
    })).toBe('zh-CN');
  });
});
