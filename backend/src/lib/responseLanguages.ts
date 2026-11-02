// The languages a user can ask the assistant to answer in (Settings >
// Personalisation > Response style). Shared kernel: the user module validates
// against it and the chat engine names the language in the prompt.
//
// `auto` is the default and adds nothing to the prompt: the assistant answers
// in the language the user writes in. Codes are BCP 47 tags. Adding a language
// here needs no migration; the frontend list in
// components/settings/ResponseStyleSection.tsx mirrors this one.

export const RESPONSE_LANGUAGE_AUTO = "auto";

/** Code to the English name used when instructing the model. */
export const RESPONSE_LANGUAGES = {
    "en-US": "American English",
    "en-GB": "British English",
    ar: "Arabic",
    "zh-Hans": "Simplified Chinese",
    "zh-Hant": "Traditional Chinese",
    cs: "Czech",
    da: "Danish",
    nl: "Dutch",
    fi: "Finnish",
    fr: "French",
    de: "German",
    el: "Greek",
    he: "Hebrew",
    hi: "Hindi",
    id: "Indonesian",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    ms: "Malay",
    nb: "Norwegian",
    pl: "Polish",
    "pt-BR": "Brazilian Portuguese",
    "pt-PT": "European Portuguese",
    ru: "Russian",
    es: "Spanish",
    sv: "Swedish",
    th: "Thai",
    tr: "Turkish",
    uk: "Ukrainian",
    vi: "Vietnamese",
} as const;

export type ResponseLanguageCode =
    | typeof RESPONSE_LANGUAGE_AUTO
    | keyof typeof RESPONSE_LANGUAGES;

export const RESPONSE_LANGUAGE_CODES = [
    RESPONSE_LANGUAGE_AUTO,
    ...Object.keys(RESPONSE_LANGUAGES),
] as readonly ResponseLanguageCode[];

/** The language's English name, or null for `auto` and unknown codes. */
export function responseLanguageName(code: string | undefined): string | null {
    if (!code || code === RESPONSE_LANGUAGE_AUTO) return null;
    return Object.prototype.hasOwnProperty.call(RESPONSE_LANGUAGES, code)
        ? RESPONSE_LANGUAGES[code as keyof typeof RESPONSE_LANGUAGES]
        : null;
}
