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

const WEB_SEARCH_FAMILIES = Object.keys(
    WEB_SEARCH_FAMILY_CHOICES,
) as WebSearchFamily[];

/** Every field a web search update may name. */
export const WEB_SEARCH_FIELDS = ["enabled", ...WEB_SEARCH_FAMILIES] as const;

export type WebSearchField = (typeof WEB_SEARCH_FIELDS)[number];

export function isWebSearchChoice<F extends WebSearchFamily>(
    family: F,
    value: unknown,
): value is WebSearchSettings[F] {
    return (WEB_SEARCH_FAMILY_CHOICES[family] as readonly unknown[]).includes(
        value,
    );
}

/**
 * Settings from a stored JSON value, which holds only the choices that differ
 * from the default (a person's in user_profiles.web_search, an
 * organization's in organizations.web_search). Anything missing or no longer
 * valid reads as its default.
 */
export function webSearchSettingsFromStored(stored: unknown): WebSearchSettings {
    const record =
        stored && typeof stored === "object" && !Array.isArray(stored)
            ? (stored as Record<string, unknown>)
            : {};
    const choice = <F extends WebSearchFamily>(
        family: F,
    ): WebSearchSettings[F] => {
        const value = record[family];
        return isWebSearchChoice(family, value)
            ? value
            : DEFAULT_WEB_SEARCH_SETTINGS[family];
    };
    return {
        enabled:
            typeof record.enabled === "boolean"
                ? record.enabled
                : DEFAULT_WEB_SEARCH_SETTINGS.enabled,
        claude: choice("claude"),
        openai: choice("openai"),
        other: choice("other"),
    };
}

/** The stored form of `settings`: only the choices that differ from the default. */
export function webSearchSettingsToStored(
    settings: WebSearchSettings,
): Record<string, unknown> {
    const stored: Record<string, unknown> = {};
    for (const field of WEB_SEARCH_FIELDS) {
        if (settings[field] !== DEFAULT_WEB_SEARCH_SETTINGS[field])
            stored[field] = settings[field];
    }
    return stored;
}

/**
 * Validate a partial update: a JSON object naming at least one field, each
 * with an allowed value.
 */
export function parseWebSearchUpdate(
    body: unknown,
):
    | { ok: true; update: Partial<WebSearchSettings> }
    | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }
    const raw = body as Record<string, unknown>;
    const unsupported = Object.keys(raw).find(
        (key) => !(WEB_SEARCH_FIELDS as readonly string[]).includes(key),
    );
    if (unsupported) {
        return {
            ok: false,
            detail: `Unsupported web search field: ${unsupported}`,
        };
    }
    if (WEB_SEARCH_FIELDS.every((field) => raw[field] === undefined)) {
        return {
            ok: false,
            detail: `Expected one of: ${WEB_SEARCH_FIELDS.join(", ")}`,
        };
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        return { ok: false, detail: "enabled must be a boolean" };
    }
    const update: Partial<WebSearchSettings> =
        raw.enabled !== undefined ? { enabled: raw.enabled } : {};
    for (const family of WEB_SEARCH_FAMILIES) {
        const value = raw[family];
        if (value === undefined) continue;
        if (!isWebSearchChoice(family, value)) {
            return {
                ok: false,
                detail: `${family} must be one of: ${WEB_SEARCH_FAMILY_CHOICES[family].join(", ")}`,
            };
        }
        Object.assign(update, { [family]: value });
    }
    return { ok: true, update };
}
