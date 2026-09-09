export type ResolvedLanguage = "ja" | "en" | "zh-CN" | "zh-TW" | "ko" | "es" | "fr" | "de" | "pt-BR";
export type AppLanguage = "system" | ResolvedLanguage;
export type ExtraLanguage = Exclude<ResolvedLanguage, "ja" | "en">;
export type TranslationRow = readonly [string, string, string, string, string, string, string];
