export type LanguageOption = {
  code: string;
  label: string;
  locale: string;
};

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "en", label: "English", locale: "en-US" },
  { code: "ko", label: "Korean", locale: "ko-KR" },
  { code: "ja", label: "Japanese", locale: "ja-JP" },
  { code: "es", label: "Spanish", locale: "es-ES" },
  { code: "fr", label: "French", locale: "fr-FR" },
  { code: "de", label: "German", locale: "de-DE" },
  { code: "zh", label: "Chinese", locale: "zh-CN" },
  { code: "pt", label: "Portuguese", locale: "pt-BR" },
  { code: "it", label: "Italian", locale: "it-IT" },
  { code: "th", label: "Thai", locale: "th-TH" },
];

export const DEFAULT_TARGET_LANGUAGE = "en";

export function getLanguageByCode(code?: string | null) {
  return LANGUAGE_OPTIONS.find((language) => language.code === code) ?? null;
}

export function getLanguageLabel(code?: string | null) {
  return getLanguageByCode(code)?.label ?? "Unknown";
}
