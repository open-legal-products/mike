// An organization's preferences for the work done in its workspace.
//
// In Personal, Settings > Features and Settings > Model Preferences are the
// person's own (user_profiles). In an organization's workspace the
// organization governs them: its owners and admins choose the models used
// for titles, reviews, memory curation and subagents, whether web search is
// on and through what, and which assistant features show — and every
// member's work there follows those choices. They are columns on
// organizations, mirroring the user_profiles ones.
//
// Only team organizations have a workspace of their own; a person's own
// organization (personalOrgs.ts) is Personal, which reads the profile.

import { getOrgRole } from "./access";
import type { ReasoningLevel } from "./llm";
import { normalizeReasoningLevel } from "./modelSelection";
import { teamOrgIdOf } from "./personalOrgs";
import type { Db } from "./supabase";
import {
    DEFAULT_WEB_SEARCH_SETTINGS,
    webSearchSettingsFromStored,
    type WebSearchSettings,
} from "./webSearch/settings";

/** The wire shape of GET and PATCH /orgs/:orgId/preferences. */
export type OrgPreferences = {
    /** Explicit override; null derives the title model from the chat. */
    title_model: string | null;
    /** Preselected for new reviews only; each review stores its own model. */
    tabular_model: string | null;
    memory_curator_model: string | null;
    /** Told to the assistant as defaults for its subagents. */
    subagent_model: string | null;
    subagent_reasoning: ReasoningLevel | null;
    quick_actions_visible: boolean;
    response_details_visible: boolean;
    web_search: WebSearchSettings;
};

export const ORG_PREFERENCE_MODEL_FIELDS = [
    "title_model",
    "tabular_model",
    "memory_curator_model",
    "subagent_model",
] as const;

export type OrgPreferenceModelField =
    (typeof ORG_PREFERENCE_MODEL_FIELDS)[number];

export const ORG_PREFERENCE_COLUMNS =
    "title_model, tabular_model, memory_curator_model, subagent_model, subagent_reasoning, quick_actions_visible, response_details_visible, web_search";

/** What an organization that has chosen nothing gets: the app's defaults. */
export const DEFAULT_ORG_PREFERENCES: OrgPreferences = {
    title_model: null,
    tabular_model: null,
    memory_curator_model: null,
    subagent_model: null,
    subagent_reasoning: null,
    quick_actions_visible: true,
    response_details_visible: false,
    web_search: DEFAULT_WEB_SEARCH_SETTINGS,
};

function optionalString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}

/** Preferences from an organizations row; anything missing reads as its default. */
export function orgPreferencesFromRow(row: unknown): OrgPreferences {
    const record =
        row && typeof row === "object" && !Array.isArray(row)
            ? (row as Record<string, unknown>)
            : {};
    return {
        title_model: optionalString(record.title_model),
        tabular_model: optionalString(record.tabular_model),
        memory_curator_model: optionalString(record.memory_curator_model),
        subagent_model: optionalString(record.subagent_model),
        subagent_reasoning: normalizeReasoningLevel(record.subagent_reasoning),
        quick_actions_visible:
            typeof record.quick_actions_visible === "boolean"
                ? record.quick_actions_visible
                : DEFAULT_ORG_PREFERENCES.quick_actions_visible,
        response_details_visible:
            typeof record.response_details_visible === "boolean"
                ? record.response_details_visible
                : DEFAULT_ORG_PREFERENCES.response_details_visible,
        web_search: webSearchSettingsFromStored(record.web_search),
    };
}

/**
 * The columns are not there yet: the backend was deployed before the
 * migration ran (Postgres "undefined column", directly or via PostgREST).
 */
export function isOrgPreferencesNotMigrated(error: unknown): boolean {
    const { code, message } = (error ?? {}) as {
        code?: unknown;
        message?: unknown;
    };
    const text = typeof message === "string" ? message : "";
    return (
        (code === "42703" || code === "PGRST204") &&
        /title_model|tabular_model|memory_curator_model|subagent_|quick_actions_visible|response_details_visible|web_search/.test(
            text,
        )
    );
}

/**
 * The organization's preferences, or null when no such organization exists.
 * A database that has not migrated reads as the defaults. Any other read
 * failure throws: answering with defaults would silently change the models
 * and features of the organization's work.
 */
export async function loadOrgPreferences(
    db: Db,
    orgId: string,
): Promise<OrgPreferences | null> {
    const { data, error } = await db
        .from("organizations")
        .select(ORG_PREFERENCE_COLUMNS)
        .eq("id", orgId)
        .maybeSingle();
    if (error) {
        if (isOrgPreferencesNotMigrated(error)) return DEFAULT_ORG_PREFERENCES;
        throw new Error("Failed to read the organization's preferences");
    }
    return data ? orgPreferencesFromRow(data) : null;
}

/**
 * The preferences that govern `userId`'s work filed under `orgId`: the
 * organization's when that is a team organization they belong to, otherwise
 * null, meaning their own (Personal). This mirrors getEffectiveApiKeys: work
 * runs on an organization's keys only for its members, so it follows its
 * preferences only for them too.
 */
export async function loadWorkspacePreferences(
    db: Db,
    userId: string,
    orgId: string | null | undefined,
): Promise<OrgPreferences | null> {
    const teamOrgId = await teamOrgIdOf(db, orgId);
    if (!teamOrgId) return null;
    if (!(await getOrgRole(userId, teamOrgId, db))) return null;
    return loadOrgPreferences(db, teamOrgId);
}
