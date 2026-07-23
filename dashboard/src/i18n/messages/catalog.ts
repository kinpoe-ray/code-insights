import { enUS as coreEnUS } from './en-US';
import { zhCN as coreZhCN } from './zh-CN';
import { dashboardMessages } from './dashboard';
import { sessionsMessages } from './sessions';
import { insightsMessages } from './insights';
import { analyticsMessages } from './analytics';
import { patternsMessages } from './patterns';
import { exportMessages } from './export';
import { settingsMessages } from './settings';
import { sharedMessages } from './shared';
import { journalMessages } from './journal';
import { analysisMessages } from './analysis';
import { dispatchMessages } from './dispatch';
import { chatMessages } from './chat';
import type { MessageDefinition } from './types';

export const enUS = {
  ...coreEnUS,
  ...dashboardMessages.enUS,
  ...sessionsMessages.enUS,
  ...insightsMessages.enUS,
  ...analyticsMessages.enUS,
  ...patternsMessages.enUS,
  ...exportMessages.enUS,
  ...settingsMessages.enUS,
  ...journalMessages.enUS,
  ...analysisMessages.enUS,
  ...dispatchMessages.enUS,
  ...chatMessages.enUS,
  ...sharedMessages.enUS,
};

export type MessageKey = keyof typeof enUS;

export const zhCN = {
  ...coreZhCN,
  ...dashboardMessages.zhCN,
  ...sessionsMessages.zhCN,
  ...insightsMessages.zhCN,
  ...analyticsMessages.zhCN,
  ...patternsMessages.zhCN,
  ...exportMessages.zhCN,
  ...settingsMessages.zhCN,
  ...journalMessages.zhCN,
  ...analysisMessages.zhCN,
  ...dispatchMessages.zhCN,
  ...chatMessages.zhCN,
  ...sharedMessages.zhCN,
} satisfies { [K in MessageKey]: MessageDefinition };
