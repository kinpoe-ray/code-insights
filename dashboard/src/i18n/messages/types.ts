export type TranslationValues = Record<string, string | number>;
export type MessageDefinition = string | ((values: TranslationValues) => string);

export function defineMessages<const T extends Record<string, MessageDefinition>>(
  enUS: T,
  zhCN: { [K in keyof T]: MessageDefinition },
) {
  return { enUS, zhCN };
}
