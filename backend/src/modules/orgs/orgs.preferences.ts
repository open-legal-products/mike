// An organization's Features and Model Preferences for its workspace.
//
// Behind the module facade (orgs.service.ts). The shape, defaults and the
// loader shared with the assistant's settings read live in
// lib/orgPreferences.ts. What this file adds is who may read and change them
// — any member reads, since what they show and run on follows them; owners
// and admins change them — the validation, and the audit trail.

import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { REASONING_LEVELS, resolveModel } from "../../lib/llm";
import {
    ORG_PREFERENCE_COLUMNS,
    ORG_PREFERENCE_MODEL_FIELDS,
    isOrgPreferencesNotMigrated,
    loadOrgPreferences,
    orgPreferencesFromRow,
    type OrgPreferences,
} from "../../lib/orgPreferences";
import type { OrgResult } from "../../lib/orgs";
import type { Db } from "../../lib/supabase";
import {
    parseWebSearchUpdate,
    webSearchSettingsToStored,
    type WebSearchSettings,
} from "../../lib/webSearch";

export type { OrgPreferences } from "../../lib/orgPreferences";

type ColumnUpdate = {
    title_model?: string | null;
    tabular_model?: string | null;
    memory_curator_model?: string | null;
    subagent_model?: string | null;
    subagent_reasoning?: string | null;
    quick_actions_visible?: boolean;
    response_details_visible?: boolean;
};

export type OrgPreferencesUpdate = {
    columns: ColumnUpdate;
    webSearch?: Partial<WebSearchSettings>;
};

const FIELDS = [
    ...ORG_PREFERENCE_MODEL_FIELDS,
    "subagent_reasoning",
    "quick_actions_visible",
    "response_details_visible",
    "web_search",
] as const;

/**
 * Validate a PATCH body: an object naming at least one preference. Models
 * are checked as a person's are (user.profile.validation): null or "" clears
 * one, anything else must resolve to a model the app knows. Whether the
 * organization's keys can run it is judged when it is used, against the
 * organization's lists, as for a person.
 */
export function parseOrgPreferencesUpdate(
    body: unknown,
): { ok: true; update: OrgPreferencesUpdate } | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body))
        return { ok: false, detail: "Expected a JSON object" };
    const raw = body as Record<string, unknown>;
    const unsupported = Object.keys(raw).find(
        (key) => !(FIELDS as readonly string[]).includes(key),
    );
    if (unsupported)
        return { ok: false, detail: `Unsupported preference: ${unsupported}` };
    if (FIELDS.every((field) => raw[field] === undefined))
        return { ok: false, detail: `Expected one of: ${FIELDS.join(", ")}` };

    const columns: ColumnUpdate = {};
    for (const field of ORG_PREFERENCE_MODEL_FIELDS) {
        const value = raw[field];
        if (value === undefined) continue;
        if (value === null || value === "") {
            columns[field] = null;
            continue;
        }
        if (typeof value !== "string")
            return { ok: false, detail: `${field} must be a string or null` };
        const resolved = resolveModel(value, "");
        if (!resolved) return { ok: false, detail: `Unsupported ${field}` };
        columns[field] = resolved;
    }

    if (raw.subagent_reasoning !== undefined) {
        const value = raw.subagent_reasoning;
        if (value === null || value === "") columns.subagent_reasoning = null;
        else if ((REASONING_LEVELS as readonly unknown[]).includes(value))
            columns.subagent_reasoning = value as string;
        else return { ok: false, detail: "Unsupported subagent_reasoning" };
    }

    for (const field of [
        "quick_actions_visible",
        "response_details_visible",
    ] as const) {
        const value = raw[field];
        if (value === undefined) continue;
        if (typeof value !== "boolean")
            return { ok: false, detail: `${field} must be true or false` };
        columns[field] = value;
    }

    let webSearch: Partial<WebSearchSettings> | undefined;
    if (raw.web_search !== undefined) {
        const parsed = parseWebSearchUpdate(raw.web_search);
        if (!parsed.ok)
            return { ok: false, detail: `web_search: ${parsed.detail}` };
        webSearch = parsed.update;
    }

    return { ok: true, update: { columns, webSearch } };
}

/**
 * Any member may read them: they decide what the member's work in the
 * organization shows and runs on. None of it is a secret.
 */
export async function getOrgPreferences(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ preferences: OrgPreferences }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    try {
        const preferences = await loadOrgPreferences(db, params.orgId);
        if (!preferences) return { ok: false, kind: "not_found" };
        return { ok: true, preferences };
    } catch (error) {
        return {
            ok: false,
            kind: "db_error",
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Change some of them. Owners and admins only: they run the organization
 * day to day, as they do its provider keys. `web_search` is merged over the
 * stored choices, so changing one family leaves the others as they were.
 */
export async function updateOrgPreferences(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        body: unknown;
    },
): Promise<OrgResult<{ preferences: OrgPreferences }>> {
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const parsed = parseOrgPreferencesUpdate(params.body);
    if (!parsed.ok) return { ok: false, kind: "validation", detail: parsed.detail };

    const { data: before, error: readError } = await db
        .from("organizations")
        .select(ORG_PREFERENCE_COLUMNS)
        .eq("id", params.orgId)
        .maybeSingle();
    if (readError)
        return {
            ok: false,
            kind: "db_error",
            detail: isOrgPreferencesNotMigrated(readError)
                ? "Organization preferences are not available until the database is migrated"
                : readError.message,
        };
    if (!before) return { ok: false, kind: "not_found" };

    const previous = orgPreferencesFromRow(before);
    const write: Record<string, unknown> = { ...parsed.update.columns };
    if (parsed.update.webSearch) {
        // Read, merge and write back: two owners changing different web
        // search choices at the same moment is the only way to lose one.
        write.web_search = webSearchSettingsToStored({
            ...previous.web_search,
            ...parsed.update.webSearch,
        });
    }

    const { data, error } = await db
        .from("organizations")
        .update({ ...write, updated_at: new Date().toISOString() })
        .eq("id", params.orgId)
        .select(ORG_PREFERENCE_COLUMNS);
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    const saved = (data as unknown[] | null)?.[0];
    if (!saved) return { ok: false, kind: "not_found" };
    const preferences = orgPreferencesFromRow(saved);

    // One event naming what changed; the values are model ids and switches,
    // which the audit log can show without exposing anybody's work.
    const changed = (Object.keys(preferences) as (keyof OrgPreferences)[])
        .filter(
            (field) =>
                JSON.stringify(preferences[field]) !==
                JSON.stringify(previous[field]),
        );
    if (changed.length > 0)
        await recordAudit(db, {
            userId: params.actorId,
            userEmail: params.actorEmail ?? null,
            orgId: params.orgId,
            action: "org.preferences.updated",
            surface: "organization",
            detail: { fields: changed },
        });

    return { ok: true, preferences };
}
