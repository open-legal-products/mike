// User profile: load, serialize, validate, bootstrap, read + update.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract (explicit `db`, request-derived primitives in, typed result objects
// out, no req/res). The profile-row loaders (ensureProfileRow / loadProfile)
// are exported for intra-module reuse by user.mfa.ts; the facade does NOT
// re-export them, so they stay off the module's public surface.

import {
    isSupportedOpenCodeGoModel,
    REASONING_LEVELS,
    resolveModel,
} from "../../lib/llm";
import {
    normalizeOptionalModelPreference,
    normalizeReasoningLevel,
} from "../../lib/modelSelection";
import {
    type ApiKeyStatus,
    getUserApiKeyStatus,
} from "./user.apiKeyStore";
import { findProfileUserByEmail } from "../../lib/userLookup";
import {
    getAllUserRouterModels,
    replaceUserRouterModels,
    ROUTER_SLUGS,
    type RouterModelSelections,
    type RouterSlug,
} from "../../lib/routerModels";
import { errorMessage, type Db } from "./user.shared";

const MONTHLY_CREDIT_LIMIT = 999999;

type UserProfileRow = {
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
    last_selected_chat_model?: string | null;
    last_selected_reasoning_level?: string | null;
    mfa_on_login: boolean | null;
    legal_research_us: boolean | null;
    quick_actions_visible: boolean | null;
    dark_mode: boolean | null;
    transparent_tables: boolean | null;
};

const PROFILE_SELECT_WITH_CHAT_SELECTIONS =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode, transparent_tables";
const PROFILE_SELECT_NO_TRANSPARENT_TABLES =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode";
const PROFILE_SELECT_WITH_LAST_SELECTED_CHAT_MODEL =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, last_selected_chat_model, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode, transparent_tables";
const PROFILE_SELECT =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us, quick_actions_visible, dark_mode, transparent_tables";
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

function withoutTransparentTables(columns: string): string {
    return columns.replace(", transparent_tables", "");
}

// Loads a profile while tolerating older databases that lack newer preference
// columns. Tries the full select first, then falls back through the legacy
// cascade (which also handles missing title_model / mfa_on_login) and applies
// safe defaults for missing fields.
async function selectProfile(db: Db, userId: string, mode: "maybe" | "single") {
    const newestQuery = db
        .from("user_profiles")
        .select(PROFILE_SELECT_WITH_CHAT_SELECTIONS)
        .eq("user_id", userId);
    const newest =
        mode === "single"
            ? await newestQuery.single()
            : await newestQuery.maybeSingle();
    if (!newest.error) return newest;
    let cascadeError: unknown = newest.error;
    let transparentTablesAvailable = true;

    // The appearance preference may be deployed before its migration. Keep
    // every older profile field and use the default transparent table style.
    if (isMissingProfileColumn(cascadeError, "transparent_tables")) {
        transparentTablesAvailable = false;
        const previousQuery = db
            .from("user_profiles")
            .select(PROFILE_SELECT_NO_TRANSPARENT_TABLES)
            .eq("user_id", userId);
        const previous =
            mode === "single"
                ? await previousQuery.single()
                : await previousQuery.maybeSingle();
        if (!previous.error) {
            if (previous.data && typeof previous.data === "object") {
                Object.assign(previous.data as Record<string, unknown>, {
                    transparent_tables: true,
                });
            }
            return previous;
        }
        cascadeError = previous.error;
    }

    if (isMissingProfileColumn(cascadeError, "last_selected_reasoning_level")) {
        const modelOnlyQuery = db
            .from("user_profiles")
            .select(
                transparentTablesAvailable
                    ? PROFILE_SELECT_WITH_LAST_SELECTED_CHAT_MODEL
                    : withoutTransparentTables(
                          PROFILE_SELECT_WITH_LAST_SELECTED_CHAT_MODEL,
                      ),
            )
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
            .select(
                transparentTablesAvailable
                    ? PROFILE_SELECT
                    : withoutTransparentTables(PROFILE_SELECT),
            )
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

const CATALOG_MODEL_ID_RE = /^[^\s/]+\/[^\s]+$/;

/**
 * A router's catalog-id shape. OpenRouter and Vercel publish vendor/model
 * pairs; OpenCode Go publishes bare model names ("glm-5"), so requiring a
 * slash there would reject its entire catalog.
 */
const ROUTER_MODEL_ID_RE: Record<RouterSlug, RegExp> = {
    openrouter: CATALOG_MODEL_ID_RE,
    vercel: CATALOG_MODEL_ID_RE,
    "opencode-go": /^[^\s]+$/,
};

/**
 * The profile field each router's selection is read from and written to.
 * Mirrored by the frontend's updateUserProfile payload.
 */
export const ROUTER_PROFILE_FIELDS: Record<RouterSlug, string> = {
    openrouter: "openRouterModels",
    vercel: "vercelModels",
    "opencode-go": "openCodeGoModels",
};

export function normalizeRouterModels(
    value: unknown,
    provider: RouterSlug,
): string[] {
    if (!Array.isArray(value)) return [];
    const models: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        // Strip a leading router slug ("openrouter/deepseek/deepseek-v3" →
        // "deepseek/deepseek-v3") only when what remains is still a full
        // vendor/model catalog id. Some catalog ids legitimately begin with
        // the router's own slug (OpenRouter's "openrouter/auto", Vercel's
        // "vercel/v0-1.5-md"); for those the raw id IS the canonical form
        // and stripping would destroy it.
        const catalogIdRe = ROUTER_MODEL_ID_RE[provider];
        const stripped = trimmed.replace(new RegExp(`^${provider}/`), "");
        const model = catalogIdRe.test(stripped) ? stripped : trimmed;
        if (
            !model ||
            model.length > 200 ||
            !catalogIdRe.test(model) ||
            (provider === "opencode-go" &&
                !isSupportedOpenCodeGoModel(model)) ||
            seen.has(model)
        ) {
            continue;
        }
        seen.add(model);
        models.push(model);
        if (models.length === 50) break;
    }
    return models;
}

function serializeProfile(
    routerModels: RouterModelSelections,
    row: UserProfileRow,
    apiKeyStatus?: ApiKeyStatus,
) {
    const creditsUsed = row.message_credits_used ?? 0;
    return {
        displayName: row.display_name,
        organisation: row.organisation,
        jurisdiction: row.jurisdiction ?? null,
        practiceSetting: row.practice_setting ?? null,
        professionalTitle: row.professional_title ?? null,
        practiceAreas: Array.isArray(row.practice_areas)
            ? row.practice_areas
            : [],
        // Databases that have not yet applied the onboarding migration must
        // not lock existing users out of the app. NULL means a new user still
        // needs onboarding; 0 identifies a legacy-exempt user; 1 is complete.
        onboardingVersion:
            row.onboarding_version === undefined ? 0 : row.onboarding_version,
        onboardingComplete:
            row.onboarding_version === undefined ||
            row.onboarding_version !== null,
        passwordSet: !!row.password_set_at,
        messageCreditsUsed: creditsUsed,
        creditsResetDate: row.credits_reset_date,
        creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
        tier: row.tier || "Free",
        titleModel: normalizeOptionalModelPreference(
            row.title_model,
            routerModels,
        ),
        tabularModel: normalizeOptionalModelPreference(
            row.tabular_model,
            routerModels,
        ),
        lastSelectedChatModel: normalizeOptionalModelPreference(
            row.last_selected_chat_model,
            routerModels,
        ),
        lastSelectedReasoningLevel:
            normalizeReasoningLevel(row.last_selected_reasoning_level) ??
            "high",
        mfaOnLogin: row.mfa_on_login === true,
        legalResearchUs: row.legal_research_us !== false,
        quickActionsVisible: row.quick_actions_visible !== false,
        darkMode: row.dark_mode === true,
        transparentTables: row.transparent_tables !== false,
        ...Object.fromEntries(
            ROUTER_SLUGS.map((slug) => [
                ROUTER_PROFILE_FIELDS[slug],
                routerModels[slug],
            ]),
        ),
        ...(apiKeyStatus ? { apiKeyStatus } : {}),
    };
}

const PRACTICE_SETTINGS = new Set([
    "private_practice",
    "in_house",
    "not_practising",
]);

const PROFESSIONAL_TITLES = new Set([
    "Partner",
    "Senior Associate",
    "Associate",
    "Law Clerk",
    "Counsel",
    "General Counsel",
    "Legal Counsel",
    "Other",
]);

function isPracticeSetting(value: string): boolean {
    return PRACTICE_SETTINGS.has(value);
}

function normalizeProfessionalTitle(value: unknown): string | null | undefined {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") return undefined;
    const title = value.trim();
    return PROFESSIONAL_TITLES.has(title) ? title : undefined;
}

function normalizePracticeAreas(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const practiceAreas = Array.from(
        new Set(
            value
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean),
        ),
    );
    if (
        practiceAreas.length > 20 ||
        practiceAreas.some((item) => item.length > 100)
    ) {
        return null;
    }
    return practiceAreas;
}

export type PersonalisationUpdate = {
    jurisdiction?: string | null;
    practice_setting?: string | null;
    professional_title?: string | null;
    practice_areas?: string[];
};

function parsePersonalisationPayload(
    raw: Record<string, unknown>,
    { allowClearing }: { allowClearing: boolean },
):
    | { ok: true; update: PersonalisationUpdate }
    | { ok: false; detail: string } {
    const update: PersonalisationUpdate = {};

    if ("jurisdiction" in raw) {
        if (
            allowClearing &&
            (raw.jurisdiction === null || raw.jurisdiction === "")
        ) {
            update.jurisdiction = null;
        } else {
            const jurisdiction =
                typeof raw.jurisdiction === "string"
                    ? raw.jurisdiction.trim()
                    : "";
            if (!jurisdiction || jurisdiction.length > 100) {
                return {
                    ok: false,
                    detail: "Select a valid jurisdiction of practice",
                };
            }
            update.jurisdiction = jurisdiction;
        }
    }

    if ("practiceSetting" in raw) {
        if (
            allowClearing &&
            (raw.practiceSetting === null || raw.practiceSetting === "")
        ) {
            update.practice_setting = null;
        } else {
            const practiceSetting =
                typeof raw.practiceSetting === "string"
                    ? raw.practiceSetting.trim()
                    : "";
            if (!isPracticeSetting(practiceSetting)) {
                return {
                    ok: false,
                    detail: "Select a valid professional setting",
                };
            }
            update.practice_setting = practiceSetting;
        }
    }

    if ("professionalTitle" in raw) {
        const professionalTitle = normalizeProfessionalTitle(
            raw.professionalTitle,
        );
        if (
            professionalTitle === undefined ||
            (!allowClearing && professionalTitle === null)
        ) {
            return { ok: false, detail: "Select a valid title" };
        }
        update.professional_title = professionalTitle;
    }

    if ("practiceAreas" in raw) {
        const practiceAreas = normalizePracticeAreas(raw.practiceAreas);
        if (!practiceAreas) {
            return {
                ok: false,
                detail: "Select no more than 20 valid practice areas",
            };
        }
        update.practice_areas = practiceAreas;
    }

    return { ok: true, update };
}

export function validateProfilePayload(body: unknown):
    | {
          ok: true;
          update: {
              display_name?: string | null;
              organisation?: string | null;
              jurisdiction?: string | null;
              practice_setting?: string | null;
              professional_title?: string | null;
              practice_areas?: string[];
              title_model?: string | null;
              tabular_model?: string | null;
              last_selected_chat_model?: string | null;
              last_selected_reasoning_level?: string | null;
              legal_research_us?: boolean;
              quick_actions_visible?: boolean;
              updated_at: string;
          };
          routerModels?: Partial<Record<RouterSlug, string[]>>;
      }
    | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }

    const raw = body as Record<string, unknown>;
    const allowedFields = new Set([
        "displayName",
        "organisation",
        "jurisdiction",
        "practiceSetting",
        "professionalTitle",
        "practiceAreas",
        "titleModel",
        "tabularModel",
        "lastSelectedChatModel",
        "lastSelectedReasoningLevel",
        "legalResearchUs",
        "quickActionsVisible",
        "darkMode",
        "transparentTables",
        ...ROUTER_SLUGS.map((slug) => ROUTER_PROFILE_FIELDS[slug]),
    ]);
    const invalidField = Object.keys(raw).find(
        (key) => !allowedFields.has(key),
    );
    if (invalidField) {
        return {
            ok: false,
            detail: `Unsupported profile field: ${invalidField}`,
        };
    }

    const update: {
        display_name?: string | null;
        organisation?: string | null;
        jurisdiction?: string | null;
        practice_setting?: string | null;
        professional_title?: string | null;
        practice_areas?: string[];
        title_model?: string | null;
        tabular_model?: string | null;
        last_selected_chat_model?: string | null;
        last_selected_reasoning_level?: string | null;
        legal_research_us?: boolean;
        quick_actions_visible?: boolean;
        dark_mode?: boolean;
        transparent_tables?: boolean;
        updated_at: string;
    } = { updated_at: new Date().toISOString() };
    const routerModels: Partial<Record<RouterSlug, string[]>> = {};

    const personalisation = parsePersonalisationPayload(raw, {
        allowClearing: true,
    });
    if (!personalisation.ok) return personalisation;
    Object.assign(update, personalisation.update);

    // Both fields flow into every chat's system prompt via
    // buildUserPersonalisationPrompt, so an unbounded value would inflate
    // token cost on every message. Truncate (not reject) at 200 characters:
    // that is exactly what the signup trigger (handle_new_user's
    // left(..., 200)) does to the same columns, and rejection would strand
    // any over-long value written before this cap existed.
    if ("displayName" in raw) {
        if (raw.displayName !== null && typeof raw.displayName !== "string") {
            return {
                ok: false,
                detail: "displayName must be a string or null",
            };
        }
        update.display_name = raw.displayName?.trim().slice(0, 200) || null;
    }

    if ("organisation" in raw) {
        if (raw.organisation !== null && typeof raw.organisation !== "string") {
            return {
                ok: false,
                detail: "organisation must be a string or null",
            };
        }
        update.organisation = raw.organisation?.trim().slice(0, 200) || null;
    }

    if ("tabularModel" in raw) {
        if (raw.tabularModel === null || raw.tabularModel === "") {
            update.tabular_model = null;
        } else if (typeof raw.tabularModel !== "string") {
            return {
                ok: false,
                detail: "tabularModel must be a string or null",
            };
        } else {
            const resolved = resolveModel(raw.tabularModel, "");
            if (!resolved) {
                return { ok: false, detail: "Unsupported tabularModel" };
            }
            update.tabular_model = resolved;
        }
    }

    if ("titleModel" in raw) {
        if (raw.titleModel === null || raw.titleModel === "") {
            update.title_model = null;
        } else if (typeof raw.titleModel !== "string") {
            return {
                ok: false,
                detail: "titleModel must be a string or null",
            };
        } else {
            const resolved = resolveModel(raw.titleModel, "");
            if (!resolved) {
                return { ok: false, detail: "Unsupported titleModel" };
            }
            update.title_model = resolved;
        }
    }

    if ("lastSelectedChatModel" in raw) {
        if (
            raw.lastSelectedChatModel === null ||
            raw.lastSelectedChatModel === ""
        ) {
            update.last_selected_chat_model = null;
        } else if (typeof raw.lastSelectedChatModel !== "string") {
            return {
                ok: false,
                detail: "lastSelectedChatModel must be a string or null",
            };
        } else {
            const resolved = resolveModel(raw.lastSelectedChatModel, "");
            if (!resolved) {
                return {
                    ok: false,
                    detail: "Unsupported lastSelectedChatModel",
                };
            }
            update.last_selected_chat_model = resolved;
        }
    }

    if ("lastSelectedReasoningLevel" in raw) {
        if (typeof raw.lastSelectedReasoningLevel !== "string") {
            return {
                ok: false,
                detail: "lastSelectedReasoningLevel must be a string",
            };
        }
        if (!(REASONING_LEVELS as readonly string[]).includes(
            raw.lastSelectedReasoningLevel,
        )) {
            return {
                ok: false,
                detail: "Unsupported lastSelectedReasoningLevel",
            };
        }
        update.last_selected_reasoning_level =
            raw.lastSelectedReasoningLevel;
    }

    for (const slug of ROUTER_SLUGS) {
        const field = ROUTER_PROFILE_FIELDS[slug];
        if (!(field in raw)) continue;
        const value = raw[field];
        if (!Array.isArray(value)) {
            return {
                ok: false,
                detail: `${field} must be an array of model IDs`,
            };
        }
        // Check the cap before normalizing: normalizeRouterModels truncates
        // at 50, so a longer payload would otherwise surface as the
        // misleading "invalid or duplicate model ID".
        if (value.length > 50) {
            return {
                ok: false,
                detail: `${field} can include at most 50 models`,
            };
        }
        const models = normalizeRouterModels(value, slug);
        if (models.length !== value.length) {
            return {
                ok: false,
                detail: `${field} contains an invalid or duplicate model ID`,
            };
        }
        routerModels[slug] = models;
    }

    if ("legalResearchUs" in raw) {
        if (typeof raw.legalResearchUs !== "boolean") {
            return {
                ok: false,
                detail: "legalResearchUs must be a boolean",
            };
        }
        update.legal_research_us = raw.legalResearchUs;
    }

    if ("quickActionsVisible" in raw) {
        if (typeof raw.quickActionsVisible !== "boolean") {
            return {
                ok: false,
                detail: "quickActionsVisible must be a boolean",
            };
        }
        update.quick_actions_visible = raw.quickActionsVisible;
    }

    if ("darkMode" in raw) {
        if (typeof raw.darkMode !== "boolean") {
            return {
                ok: false,
                detail: "darkMode must be a boolean",
            };
        }
        update.dark_mode = raw.darkMode;
    }

    if ("transparentTables" in raw) {
        if (typeof raw.transparentTables !== "boolean") {
            return {
                ok: false,
                detail: "transparentTables must be a boolean",
            };
        }
        update.transparent_tables = raw.transparentTables;
    }

    return { ok: true, update, routerModels };
}

// POST /user/onboarding accepts only the four personalisation fields and,
// unlike PATCH /user/profile, does not allow clearing them.
export function validateOnboardingPayload(
    body: unknown,
):
    | { ok: true; update: PersonalisationUpdate }
    | { ok: false; detail: string } {
    const raw =
        body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : null;
    if (!raw) return { ok: false, detail: "Expected a JSON object" };

    const invalidField = Object.keys(raw).find(
        (key) =>
            key !== "jurisdiction" &&
            key !== "practiceSetting" &&
            key !== "professionalTitle" &&
            key !== "practiceAreas",
    );
    if (invalidField) {
        return {
            ok: false,
            detail: `Unsupported onboarding field: ${invalidField}`,
        };
    }

    return parsePersonalisationPayload(raw, { allowClearing: false });
}

export function readBooleanBodyField(
    body: unknown,
    field: string,
): { ok: true; value: boolean } | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }

    const raw = body as Record<string, unknown>;
    const invalidField = Object.keys(raw).find((key) => key !== field);
    if (invalidField) {
        return { ok: false, detail: `Unsupported field: ${invalidField}` };
    }
    if (typeof raw[field] !== "boolean") {
        return { ok: false, detail: `${field} must be a boolean` };
    }

    return { ok: true, value: raw[field] };
}

export async function ensureProfileRow(db: Db, userId: string) {
    const { error } = await db
        .from("user_profiles")
        .upsert(
            { user_id: userId },
            { onConflict: "user_id", ignoreDuplicates: true },
        );
    return error;
}

export async function loadProfile(
    db: Db,
    userId: string,
    options: { repairMissing?: boolean; apiKeyStatus?: ApiKeyStatus } = {},
) {
    let { data, error } = await selectProfile(db, userId, "maybe");

    if (error) return { data: null, error };
    if (!data) {
        if (!options.repairMissing) {
            return { data: null, error: new Error("Profile not found") };
        }

        const ensureError = await ensureProfileRow(db, userId);
        if (ensureError) return { data: null, error: ensureError };

        const created = await selectProfile(db, userId, "single");
        if (created.error) return { data: null, error: created.error };
        data = created.data;
    }

    let row = data as UserProfileRow;
    if (
        row.credits_reset_date &&
        new Date() > new Date(row.credits_reset_date)
    ) {
        const creditsResetDate = new Date();
        creditsResetDate.setDate(creditsResetDate.getDate() + 30);
        const { error: resetError } = await db
            .from("user_profiles")
            .update({
                message_credits_used: 0,
                credits_reset_date: creditsResetDate.toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

        if (resetError) return { data: null, error: resetError };
        const { data: resetData, error: resetLoadError } = await selectProfile(
            db,
            userId,
            "single",
        );
        if (resetLoadError) return { data: null, error: resetLoadError };
        row = resetData as UserProfileRow;
    }

    try {
        const routerModels = await getAllUserRouterModels(userId, db);
        return {
            data: serializeProfile(routerModels, row, options.apiKeyStatus),
            error: null,
        };
    } catch (routerModelsError) {
        return {
            data: null,
            error:
                routerModelsError instanceof Error
                    ? routerModelsError
                    : new Error(errorMessage(routerModelsError)),
        };
    }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function bootstrapUserProfile(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const error = await ensureProfileRow(db, userId);
    if (error) return { ok: false, error };
    return { ok: true };
}

export async function getUserProfile(
    db: Db,
    userId: string,
): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; error: unknown }
> {
    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, {
        repairMissing: true,
        apiKeyStatus,
    });
    if (error) return { ok: false, error };
    return { ok: true, body: { ...data, apiKeyStatus } };
}

export async function lookupUserByEmail(
    db: Db,
    email: string,
): Promise<{
    exists: boolean;
    email: string;
    display_name: string | null;
}> {
    const user = await findProfileUserByEmail(db, email);
    return {
        exists: !!user,
        email: user?.email ?? email.trim().toLowerCase(),
        display_name: user?.display_name ?? null,
    };
}

export async function updateUserProfile(
    db: Db,
    userId: string,
    update: Record<string, unknown>,
    routerModels?: Partial<Record<RouterSlug, string[]>>,
): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; error: unknown }
> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return { ok: false, error: ensureError };

    const { error: updateError } = await db
        .from("user_profiles")
        .update(update)
        .eq("user_id", userId);
    if (updateError) return { ok: false, error: updateError };

    for (const slug of ROUTER_SLUGS) {
        const models = routerModels?.[slug];
        if (models === undefined) continue;
        try {
            await replaceUserRouterModels(userId, slug, models, db);
        } catch (routerModelsError) {
            return { ok: false, error: routerModelsError };
        }
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return { ok: false, error };
    return { ok: true, body: { ...data, apiKeyStatus } };
}

// ---------------------------------------------------------------------------
// Onboarding + password capability
// ---------------------------------------------------------------------------

// Records the personalisation answers and marks onboarding complete. Unlike
// the sendInternalError-backed profile handlers, these two surfaces still
// report the underlying message, so the failure results carry `detail`.
export async function completeUserOnboarding(
    db: Db,
    userId: string,
    update: PersonalisationUpdate,
): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; detail: string }
> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return { ok: false, detail: ensureError.message };

    const { error: updateError } = await db
        .from("user_profiles")
        .update({
            ...update,
            onboarding_version: 1,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (updateError) return { ok: false, detail: updateError.message };

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return { ok: false, detail: error.message };
    return { ok: true, body: { ...data, apiKeyStatus } };
}

export type RecordPasswordSetResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; kind: "db_error"; detail: string }
    | { ok: false; kind: "not_recorded"; detail: string };

// Record password capability only after verifying Supabase's auth.users row.
export async function recordPasswordSet(
    db: Db,
    userId: string,
): Promise<RecordPasswordSetResult> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return { ok: false, kind: "db_error", detail: ensureError.message };

    const { data: passwordSetAt, error: syncError } = await db.rpc(
        "sync_user_password_set",
        { p_user_id: userId },
    );
    if (syncError)
        return { ok: false, kind: "db_error", detail: syncError.message };
    if (!passwordSetAt) {
        return {
            ok: false,
            kind: "not_recorded",
            detail: "Supabase has not recorded a password for this account",
        };
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    return { ok: true, body: { ...data, apiKeyStatus } };
}
