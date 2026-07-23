import type { MessageDefinition } from './types';
import type { enUS } from './en-US';

export const zhCN = {
  'nav.dashboard': '仪表盘',
  'nav.sessions': '会话',
  'nav.insights': '洞察',
  'nav.analytics': '分析',
  'nav.patterns': '模式',
  'nav.export': '导出',
  'nav.journal': '日志',
  'nav.settings': '设置',
  'nav.openNavigation': '打开导航',
  'nav.navigationMenu': '导航菜单',
  'nav.more': '更多',
  'nav.moreOptions': '更多选项',
  'nav.additionalOptions': '其他导航选项',
  'nav.search': '搜索…',
  'nav.githubRepository': 'GitHub 仓库',
  'language.switchToChinese': '切换为中文',
  'language.switchToEnglish': '切换为英文',
} satisfies { [K in keyof typeof enUS]: MessageDefinition };
