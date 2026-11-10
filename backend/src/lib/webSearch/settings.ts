export const WEB_SEARCH_BACKENDS = ["brave", "tavily", "deepseek"] as const;

export type WebSearchBackend = (typeof WEB_SEARCH_BACKENDS)[number];

export const isWebSearchBackend = (value: string): value is WebSearchBackend =>
    (WEB_SEARCH_BACKENDS as readonly string[]).includes(value);

export const WEB_SEARCH_FAMILY_CHOICES = {
    claude: ["provider", ...WEB_SEARCH_BACKENDS, "off"],
    openai: ["provider", ...WEB_SEARCH_BACKENDS, "off"],
    other: [...WEB_SEARCH_BACKENDS, "off"],
} as const;

export type WebSearchFamily = keyof typeof WEB_SEARCH_FAMILY_CHOICES;

export type WebSearchSettings = { enabled: boolean } & {
    [F in WebSearchFamily]: (typeof WEB_SEARCH_FAMILY_CHOICES)[F][number];
};

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
    enabled: false,
    claude: "provider",
    openai: "provider",
    other: "off",
};
