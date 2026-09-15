// user profile storage — implementation behind the module facade.
import { type Db } from "./user.shared";

export const MONTHLY_CREDIT_LIMIT = 999999;

export type UserProfileRow = {
    display_name: string | null;
    organisation: string | null;
    jurisdiction?: string | null;
    practice_setting?: string | null;
    professional_title?: string | null;
    practice_areas?: string[] | null;
    onboarding_version?: number | null;
    password_set_at?: string | null;
    message_credits_used: number;
    credits_reset_date: string;
    tier: string;
    title_model: string | null;
    tabular_model: string | null;
    memory_curator_model?: string | null;
    last_selected_chat_model?: string | null;
    last_selected_reasoning_level?: string | null;
    mfa_on_login: boolean | null;
    legal_research_us: boolean | null;
    quick_actions_visible: boolean | null;
    dark_mode: boolean | null;
    project_memory_default: boolean | null;
};

const PROFILE_SELECT_NEWEST =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, memory_curator_model, last_selected_chat_model, last_selected_reasoning_level, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode, project_memory_default";

const PROFILE_SELECT_NO_MEMORY_CURATOR_MODEL =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode, project_memory_default";

const PROFILE_SELECT_WITH_CHAT_SELECTIONS =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode";

const PROFILE_SELECT_WITH_LAST_SELECTED_CHAT_MODEL =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, last_selected_chat_model, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode";

const PROFILE_SELECT =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode";

// Deploy-before-migrate tolerance is per column: a database that already has
// the 20260821 onboarding/password columns but not yet dark_mode must keep
// them rather than fall all the way back to a lower tier. This is exactly
// PROFILE_SELECT minus dark_mode.
const PROFILE_SELECT_NO_DARK_MODE =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us, quick_actions_visible";

// PROFILE_SELECT minus the 20260821 onboarding / password-capability columns,
// for databases that have not applied those migrations yet. Migration 02
// (password_set_at) gets its own tier so a database that applied 01 but not
// 02 keeps its live onboarding/personalisation columns.
const PROFILE_SELECT_NO_PASSWORD =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us, quick_actions_visible";

const PROFILE_SELECT_NO_ONBOARDING =
    "display_name, organisation, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us, quick_actions_visible";

const ONBOARDING_PROFILE_COLUMNS = [
    "jurisdiction",
    "practice_setting",
    "professional_title",
    "practice_areas",
    "onboarding_version",
];

const PROFILE_SELECT_NO_QUICK_ACTIONS =
    "display_name, organisation, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us";

const PROFILE_SELECT_NO_LEGAL =
    "display_name, organisation, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login";

const LEGACY_PROFILE_SELECT =
    "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model";

const LEGACY_PROFILE_MODEL_SELECT =
    "display_name, organisation, message_credits_used, credits_reset_date, tier, title_model, tabular_model";

function isMissingProfileColumn(error: unknown, column: string): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const message = typeof record.message === "string" ? record.message : "";
    return record.code === "42703" && message.includes(column);
}

// Loads a profile while tolerating older databases that lack newer preference
// columns. Tries the full select first, then falls back through the legacy
// cascade (which also handles missing title_model / mfa_on_login) and applies
// safe defaults for missing fields.
export async function selectProfile(db: Db, userId: string, mode: "maybe" | "single") {
    const newestQuery = db
        .from("user_profiles")
        .select(PROFILE_SELECT_NEWEST)
        .eq("user_id", userId);
    const newest =
        mode === "single"
            ? await newestQuery.single()
            : await newestQuery.maybeSingle();
    if (!newest.error) return newest;
    let cascadeError: unknown = newest.error;

    if (isMissingProfileColumn(cascadeError, "memory_curator_model")) {
        const previousQuery = db
            .from("user_profiles")
            .select(PROFILE_SELECT_NO_MEMORY_CURATOR_MODEL)
            .eq("user_id", userId);
        const previous =
            mode === "single"
                ? await previousQuery.single()
                : await previousQuery.maybeSingle();
        if (!previous.error) {
            if (previous.data && typeof previous.data === "object") {
                Object.assign(previous.data as Record<string, unknown>, {
                    memory_curator_model: null,
                });
            }
            return previous;
        }
        cascadeError = previous.error;
    }

    if (isMissingProfileColumn(cascadeError, "last_selected_reasoning_level")) {
        const modelOnlyQuery = db
            .from("user_profiles")
            .select(PROFILE_SELECT_WITH_LAST_SELECTED_CHAT_MODEL)
            .eq("user_id", userId);
        const modelOnly =
            mode === "single"
                ? await modelOnlyQuery.single()
                : await modelOnlyQuery.maybeSingle();
        if (!modelOnly.error) {
            if (modelOnly.data && typeof modelOnly.data === "object") {
                Object.assign(modelOnly.data as Record<string, unknown>, {
                    last_selected_reasoning_level: null,
                });
            }
            return modelOnly;
        }
        cascadeError = modelOnly.error;
    }

    if (isMissingProfileColumn(cascadeError, "last_selected_chat_model")) {
        const fullQuery = db
            .from("user_profiles")
            .select(PROFILE_SELECT)
            .eq("user_id", userId);
        const full =
            mode === "single"
                ? await fullQuery.single()
                : await fullQuery.maybeSingle();
        if (!full.error) {
            if (full.data && typeof full.data === "object") {
                Object.assign(full.data as Record<string, unknown>, {
                    last_selected_chat_model: null,
                    last_selected_reasoning_level: null,
                });
            }
            return full;
        }
        cascadeError = full.error;
    }

    // dark_mode's retry tier sits above the 20260821 tiers: a database
    // missing only dark_mode keeps its live
    // onboarding, password and quick-action columns and defaults the theme
    // to light. A database old enough to lack the 20260821 columns too
    // fails the full select on one of those instead (they sort earlier in
    // the select list), so this tier is skipped and the tiers below handle it.
    if (isMissingProfileColumn(cascadeError, "dark_mode")) {
        const noDarkQuery = db
            .from("user_profiles")
            .select(PROFILE_SELECT_NO_DARK_MODE)
            .eq("user_id", userId);
        const noDark =
            mode === "single"
                ? await noDarkQuery.single()
                : await noDarkQuery.maybeSingle();
        if (!noDark.error) {
            if (noDark.data && typeof noDark.data === "object") {
                Object.assign(noDark.data as Record<string, unknown>, {
                    dark_mode: false,
                });
            }
            return noDark;
        }
        cascadeError = noDark.error;
    }

    // A database that predates the 20260821 migrations rejects the full
    // select on the first of the new columns, which would otherwise skip
    // every tier below (they key on *their* new column's name) and land on
    // a select that silently resets the legal-research and quick-action
    // preferences to defaults. Two retry tiers, most-migrated first:
    // missing only password_set_at (migration 02) keeps the live
    // onboarding columns; missing the migration-01 columns drops them all,
    // and serializeProfile treats the absent fields as legacy-exempt —
    // matching what the migration's backfill would write.
    if (isMissingProfileColumn(cascadeError, "password_set_at")) {
        const prePasswordQuery = db
            .from("user_profiles")
            .select(PROFILE_SELECT_NO_PASSWORD)
            .eq("user_id", userId);
        const prePassword =
            mode === "single"
                ? await prePasswordQuery.single()
                : await prePasswordQuery.maybeSingle();
        if (!prePassword.error) return prePassword;
        cascadeError = prePassword.error;
    }
    if (
        ONBOARDING_PROFILE_COLUMNS.some((column) =>
            isMissingProfileColumn(cascadeError, column),
        )
    ) {
        const preOnboardingQuery = db
            .from("user_profiles")
            .select(PROFILE_SELECT_NO_ONBOARDING)
            .eq("user_id", userId);
        const preOnboarding =
            mode === "single"
                ? await preOnboardingQuery.single()
                : await preOnboardingQuery.maybeSingle();
        if (!preOnboarding.error) return preOnboarding;
        cascadeError = preOnboarding.error;
    }

    if (isMissingProfileColumn(cascadeError, "quick_actions_visible")) {
        const previousQuery = db
            .from("user_profiles")
            .select(PROFILE_SELECT_NO_QUICK_ACTIONS)
            .eq("user_id", userId);
        const previous =
            mode === "single"
                ? await previousQuery.single()
                : await previousQuery.maybeSingle();
        if (!previous.error) {
            if (previous.data && typeof previous.data === "object") {
                Object.assign(previous.data, {
                    quick_actions_visible: true,
                    dark_mode: false,
                });
            }
            return previous;
        }
    }

    const legacy = await selectProfileLegacy(db, userId, mode);
    if (legacy.data && typeof legacy.data === "object") {
        const row = legacy.data as Record<string, unknown>;
        if (!("legal_research_us" in row)) {
            Object.assign(row, { legal_research_us: true });
        }
        Object.assign(row, { quick_actions_visible: true });
        if (!("dark_mode" in row)) {
            Object.assign(row, { dark_mode: false });
        }
    }
    return legacy;
}

async function selectProfileLegacy(
    db: Db,
    userId: string,
    mode: "maybe" | "single",
) {
    const query = db
        .from("user_profiles")
        .select(PROFILE_SELECT_NO_LEGAL)
        .eq("user_id", userId);
    const result =
        mode === "single" ? await query.single() : await query.maybeSingle();
    if (!result.error) {
        return result;
    }

    const missingMfaOnLogin = isMissingProfileColumn(
        result.error,
        "mfa_on_login",
    );
    if (missingMfaOnLogin) {
        const modelQuery = db
            .from("user_profiles")
            .select(LEGACY_PROFILE_MODEL_SELECT)
            .eq("user_id", userId);
        const modelLegacy =
            mode === "single"
                ? await modelQuery.single()
                : await modelQuery.maybeSingle();
        if (
            !modelLegacy.error ||
            !isMissingProfileColumn(modelLegacy.error, "title_model")
        ) {
            if (modelLegacy.data && typeof modelLegacy.data === "object") {
                const row = modelLegacy.data as Record<string, unknown>;
                Object.assign(row, {
                    mfa_on_login: false,
                });
            }
            return modelLegacy;
        }
    }

    if (
        !missingMfaOnLogin &&
        !isMissingProfileColumn(result.error, "title_model")
    ) {
        return result;
    }

    const legacyQuery = db
        .from("user_profiles")
        .select(LEGACY_PROFILE_SELECT)
        .eq("user_id", userId);
    const legacy =
        mode === "single"
            ? await legacyQuery.single()
            : await legacyQuery.maybeSingle();
    if (legacy.data && typeof legacy.data === "object") {
        const row = legacy.data as Record<string, unknown>;
        Object.assign(row, {
            title_model: null,
            mfa_on_login: false,
        });
    }
    return legacy;
}
