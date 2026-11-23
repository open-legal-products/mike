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
    WEB_SEARCH_FIELDS,
    parseWebSearchUpdate,
    webSearchSettingsFromStored,
    type WebSearchSettings,
} from "../../lib/webSearch";
import { type Db } from "./user.shared";

const COLUMN = "web_search";
const MERGE_FUNCTION = "merge_user_web_search";

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
    return webSearchSettingsFromStored(
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

/** Validate a PUT /user/web-search body; shared with an organization's. */
export const validateWebSearchPayload = parseWebSearchUpdate;

/** A choice back at its default is sent as null, which removes its key. */
function toStoredPatch(
    update: Partial<WebSearchSettings>,
): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const field of WEB_SEARCH_FIELDS) {
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
    return ok(webSearchSettingsFromStored(data));
}
