import { CORE_TRANSLATIONS } from "./translations-core";
import { HELP_TRANSLATIONS } from "./translations-help";
import { WORKFLOW_TRANSLATIONS_A } from "./translations-workflow-a";
import { WORKFLOW_TRANSLATIONS_B } from "./translations-workflow-b";
import { WORKFLOW_TRANSLATIONS_C } from "./translations-workflow-c";
import type { AppLanguage, ExtraLanguage, ResolvedLanguage, TranslationRow } from "./types";

export type { AppLanguage, ResolvedLanguage } from "./types";

const EXTRA_LANGUAGES: readonly ExtraLanguage[] = ["zh-CN", "zh-TW", "ko", "es", "fr", "de", "pt-BR"];
const EXTRA_LANGUAGE_INDEX = Object.fromEntries(EXTRA_LANGUAGES.map((language, index) => [language, index])) as Record<ExtraLanguage, number>;
const TRANSLATIONS: Record<string, TranslationRow> = {
  ...CORE_TRANSLATIONS,
  ...HELP_TRANSLATIONS,
  ...WORKFLOW_TRANSLATIONS_A,
  ...WORKFLOW_TRANSLATIONS_B,
  ...WORKFLOW_TRANSLATIONS_C,
};

export const LANGUAGE_OPTIONS: ReadonlyArray<{ id: AppLanguage; label: string; detailJa: string; detailEn: string }> = [
  { id: "system", label: "System", detailJa: "macOSの優先言語から対応言語を自動選択", detailEn: "Use the first supported language from macOS preferences" },
  { id: "ja", label: "日本語", detailJa: "日本語で表示", detailEn: "Display in Japanese" },
  { id: "en", label: "English", detailJa: "英語で表示", detailEn: "Display in English" },
  { id: "zh-CN", label: "简体中文", detailJa: "簡体字中国語で表示", detailEn: "Display in Simplified Chinese" },
  { id: "zh-TW", label: "繁體中文", detailJa: "繁体字中国語で表示", detailEn: "Display in Traditional Chinese" },
  { id: "ko", label: "한국어", detailJa: "韓国語で表示", detailEn: "Display in Korean" },
  { id: "es", label: "Español", detailJa: "スペイン語で表示", detailEn: "Display in Spanish" },
  { id: "fr", label: "Français", detailJa: "フランス語で表示", detailEn: "Display in French" },
  { id: "de", label: "Deutsch", detailJa: "ドイツ語で表示", detailEn: "Display in German" },
  { id: "pt-BR", label: "Português (Brasil)", detailJa: "ブラジルポルトガル語で表示", detailEn: "Display in Brazilian Portuguese" },
];

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "system" || value === "ja" || value === "en" || value === "zh-CN" || value === "zh-TW" || value === "ko" || value === "es" || value === "fr" || value === "de" || value === "pt-BR";
}

function resolveTag(rawTag: string): ResolvedLanguage | null {
  const tag = rawTag.trim().replaceAll("_", "-").toLowerCase();
  if (!tag) return null;
  if (tag === "ja" || tag.startsWith("ja-")) return "ja";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag === "ko" || tag.startsWith("ko-")) return "ko";
  if (tag === "es" || tag.startsWith("es-")) return "es";
  if (tag === "fr" || tag.startsWith("fr-")) return "fr";
  if (tag === "de" || tag.startsWith("de-")) return "de";
  if (tag === "pt" || tag.startsWith("pt-")) return "pt-BR";
  if (tag === "zh" || tag.startsWith("zh-")) {
    if (tag.includes("hant") || tag.startsWith("zh-tw") || tag.startsWith("zh-hk") || tag.startsWith("zh-mo")) return "zh-TW";
    return "zh-CN";
  }
  return null;
}

export function resolveLanguage(language: AppLanguage, preferredLanguages?: readonly string[]): ResolvedLanguage {
  if (language !== "system") return language;
  const candidates = preferredLanguages?.length
    ? preferredLanguages
    : typeof navigator !== "undefined"
      ? (navigator.languages?.length ? navigator.languages : [navigator.language])
      : ["en"];
  for (const candidate of candidates) {
    const resolved = resolveTag(candidate);
    if (resolved) return resolved;
  }
  return "en";
}

type DynamicTranslation = { pattern: RegExp; rows: TranslationRow };
const DYNAMIC_TRANSLATIONS: readonly DynamicTranslation[] = [
  { pattern: /^v(.+) is available$/, rows: ["可更新到 v$1", "可更新至 v$1", "v$1 업데이트 가능", "v$1 está disponible", "v$1 est disponible", "v$1 ist verfügbar", "v$1 está disponível"] },
  { pattern: /^Installing v(.+)…$/, rows: ["正在安装 v$1…", "正在安裝 v$1…", "v$1 설치 중…", "Instalando v$1…", "Installation de v$1…", "v$1 wird installiert…", "Instalando v$1…"] },
  { pattern: /^Remove (.+) from queue$/, rows: ["从队列移除 $1", "從佇列移除 $1", "큐에서 $1 제거", "Quitar $1 de la cola", "Retirer $1 de la file", "$1 aus der Warteschlange entfernen", "Remover $1 da fila"] },
  { pattern: /^Name \(defaults to (.+)\)$/, rows: ["名称（默认 $1）", "名稱（預設 $1）", "이름 (기본값 $1)", "Nombre (predeterminado: $1)", "Nom (par défaut : $1)", "Name (Standard: $1)", "Nome (padrão: $1)"] },
  { pattern: /^After enhancement, compress toward a maximum of (.+)\.$/, rows: ["增强后压缩至最大 $1。", "增強後壓縮至最大 $1。", "향상 후 최대 $1을 목표로 압축합니다.", "Después de mejorar, comprime hacia un máximo de $1.", "Après amélioration, compressez vers un maximum de $1.", "Nach der Verbesserung auf maximal $1 komprimieren.", "Após a melhoria, comprime visando no máximo $1."] },
  { pattern: /^Automatically adjusts quality to prioritize the (.+) maximum\. If exact PNG output cannot meet the limit, Agent-2D fails explicitly instead of silently degrading it\.$/, rows: ["自动调整质量，优先满足最大 $1。若 Exact PNG 无法满足限制，Agent-2D 会明确报错。", "自動調整品質，優先滿足最大 $1。若 Exact PNG 無法滿足限制，Agent-2D 會明確報錯。", "최대 $1을 우선하도록 품질을 자동 조정합니다. Exact PNG가 제한을 맞추지 못하면 명시적으로 실패합니다.", "Ajusta la calidad para priorizar el máximo de $1. Si PNG Exact no cumple el límite, Agent-2D falla de forma explícita.", "Ajuste la qualité pour privilégier le maximum de $1. Si PNG Exact ne respecte pas la limite, Agent-2D échoue explicitement.", "Passt die Qualität für maximal $1 an. Kann PNG Exact das Limit nicht einhalten, bricht Agent-2D ausdrücklich ab.", "Ajusta a qualidade para priorizar o máximo de $1. Se PNG Exact não cumprir o limite, o Agent-2D falha explicitamente."] },
  { pattern: /^(.+) undo · Option-click exclude · Shift-drag box$/, rows: ["$1 撤销 · Option+点击排除 · Shift+拖动框选", "$1 復原 · Option+點擊排除 · Shift+拖曳框選", "$1 실행 취소 · Option+클릭 제외 · Shift+드래그 박스", "$1 deshacer · Option-clic excluir · Shift-arrastrar cuadro", "$1 annuler · Option-clic exclure · Shift-glisser cadre", "$1 rückgängig · Option-Klick ausschließen · Shift-Ziehen Box", "$1 desfazer · Option+clique excluir · Shift+arrastar caixa"] },
  { pattern: /^Click include · ⌥ exclude · ⇧-drag box · (.+) undo$/, rows: ["点击选择 · ⌥ 排除 · ⇧拖动框选 · $1 撤销", "點擊選取 · ⌥ 排除 · ⇧拖曳框選 · $1 復原", "클릭 포함 · ⌥ 제외 · ⇧-드래그 박스 · $1 실행 취소", "Clic incluir · ⌥ excluir · ⇧-arrastrar cuadro · $1 deshacer", "Clic inclure · ⌥ exclure · ⇧-glisser cadre · $1 annuler", "Klick einbeziehen · ⌥ ausschließen · ⇧-Ziehen Box · $1 rückgängig", "Clique incluir · ⌥ excluir · ⇧-arrastar caixa · $1 desfazer"] },
  { pattern: /^Each input name → (.+) \/ conflicts use _02, _03…$/, rows: ["各输入名 → $1 / 冲突时使用 _02、_03…", "各輸入名稱 → $1 / 衝突時使用 _02、_03…", "각 입력 이름 → $1 / 충돌 시 _02, _03… 사용", "Cada nombre de entrada → $1 / conflictos: _02, _03…", "Chaque nom d’entrée → $1 / conflits : _02, _03…", "Jeder Eingabename → $1 / bei Konflikten _02, _03…", "Cada nome de entrada → $1 / conflitos usam _02, _03…"] },
  { pattern: /^Edit (.+) shortcut$/, rows: ["编辑 $1 快捷键", "編輯 $1 快捷鍵", "$1 단축키 편집", "Editar atajo $1", "Modifier le raccourci $1", "Kurzbefehl $1 bearbeiten", "Editar atalho $1"] },
  { pattern: /^Decrease (.+)$/, rows: ["减小 $1", "減少 $1", "$1 줄이기", "Disminuir $1", "Diminuer $1", "$1 verringern", "Diminuir $1"] },
  { pattern: /^Increase (.+)$/, rows: ["增大 $1", "增加 $1", "$1 늘리기", "Aumentar $1", "Augmenter $1", "$1 erhöhen", "Aumentar $1"] },
  { pattern: /^Delete (.+)$/, rows: ["删除 $1", "刪除 $1", "$1 삭제", "Eliminar $1", "Supprimer $1", "$1 löschen", "Excluir $1"] },
  { pattern: /^(.+) information$/, rows: ["$1 说明", "$1 說明", "$1 정보", "Información de $1", "Informations sur $1", "$1 Informationen", "Informações de $1"] },
  { pattern: /^Elapsed (.+)$/, rows: ["耗时 $1", "耗時 $1", "소요 $1", "Transcurrido $1", "Écoulé $1", "Dauer $1", "Decorrido $1"] },
  { pattern: /^About (.+) remaining$/, rows: ["约剩余 $1", "約剩餘 $1", "약 $1 남음", "Quedan unos $1", "Environ $1 restantes", "Noch etwa $1", "Cerca de $1 restantes"] },
];

function extraTranslation(language: ExtraLanguage, english: string): string | undefined {
  const exact = TRANSLATIONS[english];
  const index = EXTRA_LANGUAGE_INDEX[language];
  if (exact) return exact[index];
  for (const item of DYNAMIC_TRANSLATIONS) {
    const match = english.match(item.pattern);
    if (!match) continue;
    let translated = item.rows[index];
    for (let capture = 1; capture < match.length; capture += 1) translated = translated.replaceAll(`$${capture}`, match[capture] ?? "");
    return translated;
  }
  return undefined;
}

export function translatePair(language: ResolvedLanguage, japanese: string, english: string): string {
  if (language === "ja") return japanese;
  if (language === "en") return english;
  return extraTranslation(language, english) ?? english;
}

export function hasExtraTranslation(english: string): boolean {
  return Boolean(TRANSLATIONS[english]) || DYNAMIC_TRANSLATIONS.some((item) => item.pattern.test(english));
}
