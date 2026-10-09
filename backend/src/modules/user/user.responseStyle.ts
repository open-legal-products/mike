// user response style — implementation behind the module facade.
//
// How the user wants assistant answers written, from Settings >
// Personalisation. Like custom instructions it has its own endpoint, so the
// profile select cascade (user.profile.storage.ts) does not have to carry it.
//
// The settings live in one JSON column, user_profiles.response_style, holding
// only the choices that differ from the default. This module owns the options,
// the defaults and the validation, so adding a setting or an option is a code
// change with no migration.
import { RESPONSE_LANGUAGE_CODES } from "../../lib/responseLanguages";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import { type Db } from "./user.shared";

export const RESPONSE_STYLE_OPTIONS = {
    verbosity: ["concise", "balanced", "detailed"],
    // The "Headers and Lists" setting: how much structure answers use.
    formatting: ["balanced", "less", "more"],
    tone: ["formal", "balanced", "plain"],
    language: RESPONSE_LANGUAGE_CODES,
} as const;

type Options = typeof RESPONSE_STYLE_OPTIONS;
export type ResponseStyleField = keyof Options;
export type ResponseStyle = {
    [Field in ResponseStyleField]: Options[Field][number];
};

export const DEFAULT_RESPONSE_STYLE: ResponseStyle = {
    verbosity: "balanced",
    formatting: "balanced",
    tone: "balanced",
    language: "auto",
};

const COLUMN = "response_style";
const MERGE_FUNCTION = "merge_user_response_style";
const FIELDS = Object.keys(DEFAULT_RESPONSE_STYLE) as ResponseStyleField[];

function isOption<Field extends ResponseStyleField>(
    field: Field,
    value: unknown,
): value is ResponseStyle[Field] {
    return (
        typeof value === "string" &&
        (RESPONSE_STYLE_OPTIONS[field] as readonly string[]).includes(value)
    );
}

function errorCode(error: unknown): string {
    const code =
        error && typeof error === "object"
            ? (error as { code?: unknown }).code
            : undefined;
    return typeof code === "string" ? code : "";
}

/** The column or the merge function is not there yet: deployed before migrating. */
function isNotMigrated(error: unknown): boolean {
    const message =
        error && typeof error === "object"
            ? (error as { message?: unknown }).message
            : undefined;
    const text = typeof message === "string" ? message : "";
    const code = errorCode(error);
    return (
        ((code === "42703" || code === "PGRST204") && text.includes(COLUMN)) ||
        ((code === "PGRST202" || code === "42883") &&
            text.includes(MERGE_FUNCTION))
    );
}

/**
 * Reads a stored object into a full style. A missing key is the default, and
 * so is a value this build does not recognise (a removed option, or one
 * written by a newer build), so a stale row can never break a chat.
 */
function toResponseStyle(stored: unknown): ResponseStyle {
    const record =
        stored && typeof stored === "object" && !Array.isArray(stored)
            ? (stored as Record<string, unknown>)
            : {};
    const style = { ...DEFAULT_RESPONSE_STYLE };
    for (const field of FIELDS) {
        const value = record[field];
        if (isOption(field, value)) {
            (style as Record<ResponseStyleField, string>)[field] = value;
        }
    }
    return style;
}

/**
 * Reads the stored style. A database that has not applied the migration yet
 * reads as the default instead of failing every chat request.
 */
export async function loadResponseStyle(
    db: Db,
    userId: string,
): Promise<ResponseStyle> {
    const { data, error } = await db
        .from("user_profiles")
        .select(COLUMN)
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        if (isNotMigrated(error)) return DEFAULT_RESPONSE_STYLE;
        throw error;
    }
    return toResponseStyle(
        (data as { response_style?: unknown } | null)?.response_style,
    );
}

export async function getResponseStyle(
    db: Db,
    userId: string,
): Promise<ServiceResult<ResponseStyle>> {
    try {
        return ok(await loadResponseStyle(db, userId));
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Accepts any non-empty subset of the fields, so each setting saves on its
 * own and two quick changes to different settings cannot undo each other.
 */
export function validateResponseStylePayload(
    body: unknown,
):
    | { ok: true; update: Partial<ResponseStyle> }
    | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }
    const raw = body as Record<string, unknown>;
    const keys = Object.keys(raw);
    const invalidField = keys.find(
        (key) => !(FIELDS as string[]).includes(key),
    );
    if (invalidField) {
        return {
            ok: false,
            detail: `Unsupported response style field: ${invalidField}`,
        };
    }
    if (keys.length === 0) {
        return {
            ok: false,
            detail: "Expected at least one response style field",
        };
    }
    const update: Partial<ResponseStyle> = {};
    for (const field of keys as ResponseStyleField[]) {
        const value = raw[field];
        if (!isOption(field, value)) {
            return {
                ok: false,
                detail:
                    field === "language"
                        ? "language is not a supported language"
                        : `${field} must be one of: ${RESPONSE_STYLE_OPTIONS[field].join(", ")}`,
            };
        }
        (update as Record<ResponseStyleField, string>)[field] = value;
    }
    return { ok: true, update };
}

/**
 * The patch the database merges in. A setting chosen back to its default is
 * sent as null, which removes its key, so only real choices are stored and a
 * later change of default reaches everyone who never chose.
 */
function toStoredPatch(
    update: Partial<ResponseStyle>,
): Record<string, string | null> {
    const patch: Record<string, string | null> = {};
    for (const field of FIELDS) {
        const value = update[field];
        if (value === undefined) continue;
        patch[field] = value === DEFAULT_RESPONSE_STYLE[field] ? null : value;
    }
    return patch;
}

export async function saveResponseStyle(
    db: Db,
    userId: string,
    update: Partial<ResponseStyle>,
): Promise<ServiceResult<ResponseStyle>> {
    // Merged in the database, so a save of one setting cannot overwrite a
    // concurrent save of another.
    const { data, error } = await db.rpc(MERGE_FUNCTION, {
        p_user_id: userId,
        p_patch: toStoredPatch(update),
    });
    if (error) {
        if (isNotMigrated(error)) {
            return failure(
                "unavailable",
                "Response style settings are not available yet.",
            );
        }
        return internalFailure(error);
    }
    // The function returns null when no profile row matched.
    if (data === null || data === undefined) {
        return failure("not_found", "Profile not found");
    }
    return ok(toResponseStyle(data));
}
