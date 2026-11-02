// user web search settings — implementation behind the module facade.
//
// Whether the assistant may search the web, and how, from Settings >
// Features. Stored as one JSON column, user_profiles.web_search, holding only
// the choices that differ from the default, like response_style.
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import {
    DEFAULT_WEB_SEARCH_SETTINGS,
    WEB_SEARCH_FAMILY_CHOICES,
    type WebSearchFamily,
    type WebSearchSettings,
} from "../../lib/webSearch";
import { type Db } from "./user.shared";

const COLUMN = "web_search";
const MERGE_FUNCTION = "merge_user_web_search";

const FAMILIES = Object.keys(WEB_SEARCH_FAMILY_CHOICES) as WebSearchFamily[];

const FIELDS = ["enabled", ...FAMILIES] as const;

function isChoice<F extends WebSearchFamily>(
    family: F,
    value: unknown,
): value is WebSearchSettings[F] {
    return (WEB_SEARCH_FAMILY_CHOICES[family] as readonly unknown[]).includes(value);
}

/** The column or the merge function is not there yet: deployed before migrating. */
function isNotMigrated(error: unknown): boolean {
    const { code, message } = (error ?? {}) as {
        code?: unknown;
        message?: unknown;
    };
    const text = typeof message === "string" ? message : "";
    return (
        ((code === "42703" || code === "PGRST204") && text.includes(COLUMN)) ||
        ((code === "PGRST202" || code === "42883") &&
            text.includes(MERGE_FUNCTION))
    );
}

function toWebSearchSettings(stored: unknown): WebSearchSettings {
    const record =
        stored && typeof stored === "object" && !Array.isArray(stored)
            ? (stored as Record<string, unknown>)
            : {};
    const choice = <F extends WebSearchFamily>(family: F): WebSearchSettings[F] => {
        const value = record[family];
        return isChoice(family, value)
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

/**
 * Reads the stored settings. A database that has not applied the migration
 * yet reads as the default (off) instead of failing every chat request.
 */
export async function loadWebSearchSettings(
    db: Db,
    userId: string,
): Promise<WebSearchSettings> {
    const { data, error } = await db
        .from("user_profiles")
        .select(COLUMN)
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        if (isNotMigrated(error)) return DEFAULT_WEB_SEARCH_SETTINGS;
        throw error;
    }
    return toWebSearchSettings(
        (data as { web_search?: unknown } | null)?.web_search,
    );
}

export async function getWebSearchSettings(
    db: Db,
    userId: string,
): Promise<ServiceResult<WebSearchSettings>> {
    try {
        return ok(await loadWebSearchSettings(db, userId));
    } catch (error) {
        return internalFailure(error);
    }
}

export function validateWebSearchPayload(
    body: unknown,
):
    | { ok: true; update: Partial<WebSearchSettings> }
    | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }
    const raw = body as Record<string, unknown>;
    const unsupported = Object.keys(raw).find(
        (key) => !(FIELDS as readonly string[]).includes(key),
    );
    if (unsupported) {
        return {
            ok: false,
            detail: `Unsupported web search field: ${unsupported}`,
        };
    }
    if (FIELDS.every((field) => raw[field] === undefined)) {
        return { ok: false, detail: `Expected one of: ${FIELDS.join(", ")}` };
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        return { ok: false, detail: "enabled must be a boolean" };
    }
    const update: Partial<WebSearchSettings> =
        raw.enabled !== undefined ? { enabled: raw.enabled } : {};
    for (const family of FAMILIES) {
        const value = raw[family];
        if (value === undefined) continue;
        if (!isChoice(family, value)) {
            return {
                ok: false,
                detail: `${family} must be one of: ${WEB_SEARCH_FAMILY_CHOICES[family].join(", ")}`,
            };
        }
        Object.assign(update, { [family]: value });
    }
    return { ok: true, update };
}

/** A choice back at its default is sent as null, which removes its key. */
function toStoredPatch(
    update: Partial<WebSearchSettings>,
): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const field of FIELDS) {
        const value = update[field];
        if (value === undefined) continue;
        patch[field] =
            value === DEFAULT_WEB_SEARCH_SETTINGS[field] ? null : value;
    }
    return patch;
}

export async function saveWebSearchSettings(
    db: Db,
    userId: string,
    update: Partial<WebSearchSettings>,
): Promise<ServiceResult<WebSearchSettings>> {
    const { data, error } = await db.rpc(MERGE_FUNCTION, {
        p_user_id: userId,
        p_patch: toStoredPatch(update),
    });
    if (error) {
        if (isNotMigrated(error)) {
            return failure(
                "unavailable",
                "Web search settings are not available yet.",
            );
        }
        return internalFailure(error);
    }
    if (data === null || data === undefined) {
        return failure("not_found", "Profile not found");
    }
    return ok(toWebSearchSettings(data));
}
