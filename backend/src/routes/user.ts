import crypto from "crypto";
import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import { sendInternalError } from "../lib/httpError";
import {
    isSupportedOpenCodeGoModel,
    REASONING_LEVELS,
    resolveModel,
} from "../lib/llm";
import {
    normalizeOptionalModelPreference,
    normalizeReasoningLevel,
} from "../lib/modelSelection";
import {
    type ApiKeyStatus,
    getUserApiKeyStatus,
    hasEnvApiKey,
    normalizeApiKeyProvider,
    saveUserApiKey,
} from "../lib/userApiKeys";
import {
    completeUserMcpConnectorOAuth,
    createUserMcpConnector,
    deleteUserMcpConnector,
    getUserMcpConnector,
    listUserMcpConnectors,
    McpOAuthRequiredError,
    refreshUserMcpConnectorTools,
    setUserMcpToolEnabled,
    startUserMcpConnectorOAuth,
    updateUserMcpConnector,
} from "../lib/mcpConnectors";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserAccountData,
    deleteUserProjects,
} from "../lib/userDataCleanup";
import {
    buildUserAccountExport,
    buildUserChatsExport,
    buildUserTabularReviewsExport,
    userExportFilename,
} from "../lib/userDataExport";
import { findProfileUserByEmail } from "../lib/userLookup";
import { configuredApiPublicUrl } from "../lib/runtimeConfig";
import {
    getAllUserRouterModels,
    replaceUserRouterModels,
    ROUTER_SLUGS,
    type RouterModelSelections,
    type RouterSlug,
} from "../lib/routerModels";

export const userRouter = Router();

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
};

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (error && typeof error === "object") {
        const record = error as {
            message?: unknown;
            details?: unknown;
            hint?: unknown;
            code?: unknown;
        };
        return (
            [record.message, record.details, record.hint, record.code]
                .filter(
                    (value): value is string =>
                        typeof value === "string" && !!value,
                )
                .join(" ") || JSON.stringify(error)
        );
    }
    return String(error);
}

function backendPublicUrl(req: {
    protocol: string;
    get(name: string): string | undefined;
}) {
    const configured = configuredApiPublicUrl();
    if (configured) return configured;
    if (process.env.NODE_ENV === "production") {
        throw new Error("API_PUBLIC_URL is required for connector OAuth");
    }
    const host = req.get("host");
    if (!host) throw new Error("Request host is required for connector OAuth");
    return new URL(`${req.protocol}://${host}`).origin;
}

function frontendUrl(path = "/settings/connectors") {
    const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
        /\/+$/,
        "",
    );
    return `${base}${path}`;
}

function shortHash(value: string) {
    return value
        ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)
        : null;
}

function mcpOAuthPopupHtml(
    payload: {
        success: boolean;
        connectorId?: string;
        detail?: string;
    },
    nonce: string,
) {
    const targetOrigin = new URL(frontendUrl()).origin;
    const targetUrl = frontendUrl();
    // `payload` is interpolated into an inline script, and JSON.stringify
    // does not escape "<" — so any caller-supplied text containing
    // "</script><script>…" would break out of the script element. Callers
    // today pass only fixed strings, but escaping "<" to its < form
    // keeps the value inside the JS literal regardless of what a future
    // caller puts in `detail`. The CSP nonce is the primary defense; the
    // popup now keeps a live window.opener (COOP is relaxed on this route),
    // so this is the belt to that suspenders.
    const message = JSON.stringify({
        type: "mcp_oauth_result",
        ...payload,
    }).replace(/</g, "\\u003c");
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP authorization</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; }
      main { max-width: 360px; padding: 24px; text-align: center; }
      p { color: #6b7280; }
    </style>
  </head>
  <body>
    <main>
      <h1>${payload.success ? "Authorization complete" : "Authorization failed"}</h1>
      <p>${payload.success ? "You can return to Mike." : "Return to Mike and try connecting again."}</p>
    </main>
    <script nonce="${nonce}">
      const message = ${message};
      const targetUrl = ${JSON.stringify(targetUrl)};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, ${JSON.stringify(targetOrigin)});
      }
      setTimeout(() => window.close(), ${payload.success ? 600 : 2500});
      ${
          payload.success
              ? "setTimeout(() => window.location.assign(targetUrl), 1000);"
              : ""
      }
    </script>
  </body>
</html>`;
}

function mcpOAuthPopupHeaders(nonce: string) {
    return {
        "Content-Security-Policy": [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            "style-src 'unsafe-inline'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ].join("; "),
        // The whole popup hand-off hinges on window.opener surviving until
        // this page has posted its result back to the app. Helmet's default
        // Cross-Origin-Opener-Policy of same-origin would move this document
        // into a fresh browsing-context group the moment the popup arrives
        // here from the (cross-origin) consent page — severing window.opener
        // and silently breaking the flow in every browser. This route opts
        // out; the strict CSP above still leaves the page unable to do
        // anything beyond its inline postMessage script.
        "Cross-Origin-Opener-Policy": "unsafe-none",
    };
}

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
async function selectProfile(
    db: ReturnType<typeof createServerSupabase>,
    userId: string,
    mode: "maybe" | "single",
) {
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

    // dark_mode is the newest column, so its retry tier sits above the
    // 20260821 tiers: a database missing only dark_mode keeps its live
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
    db: ReturnType<typeof createServerSupabase>,
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
            row.onboarding_version === undefined
                ? 0
                : row.onboarding_version,
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

function normalizeProfessionalTitle(
    value: unknown,
): string | null | undefined {
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

type PersonalisationUpdate = {
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

function validateProfilePayload(body: unknown):
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
        update.display_name =
            raw.displayName?.trim().slice(0, 200) || null;
    }

    if ("organisation" in raw) {
        if (raw.organisation !== null && typeof raw.organisation !== "string") {
            return {
                ok: false,
                detail: "organisation must be a string or null",
            };
        }
        update.organisation =
            raw.organisation?.trim().slice(0, 200) || null;
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

    return { ok: true, update, routerModels };
}

function readBooleanBodyField(
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

async function userHasVerifiedTotpFactor(
    db: ReturnType<typeof createServerSupabase>,
    userId: string,
) {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) return { ok: false as const, error };

    const factors = data.user?.factors ?? [];
    return {
        ok: true as const,
        hasVerifiedTotp: factors.some(
            (factor) =>
                factor.factor_type === "totp" && factor.status === "verified",
        ),
    };
}

async function ensureProfileRow(
    db: ReturnType<typeof createServerSupabase>,
    userId: string,
) {
    const { error } = await db
        .from("user_profiles")
        .upsert(
            { user_id: userId },
            { onConflict: "user_id", ignoreDuplicates: true },
        );
    return error;
}

async function loadProfile(
    db: ReturnType<typeof createServerSupabase>,
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

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const error = await ensureProfileRow(db, userId);
    if (error) return void sendInternalError(res, error);
    res.json({ ok: true });
});

// GET /user/lookup?email=person@example.com
userRouter.get("/lookup", requireAuth, async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!email.trim()) {
        return void res.status(400).json({ detail: "email is required" });
    }

    const db = createServerSupabase();
    const user = await findProfileUserByEmail(db, email);
    res.json({
        exists: !!user,
        email: user?.email ?? email.trim().toLowerCase(),
        display_name: user?.display_name ?? null,
    });
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, {
        repairMissing: true,
        apiKeyStatus,
    });
    if (error) return void sendInternalError(res, error);
    res.json({ ...data, apiKeyStatus });
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const parsed = validateProfilePayload(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const db = createServerSupabase();
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return void sendInternalError(res, ensureError);

    const { error: updateError } = await db
        .from("user_profiles")
        .update(parsed.update)
        .eq("user_id", userId);
    if (updateError)
        return void sendInternalError(res, updateError);

    for (const slug of ROUTER_SLUGS) {
        const models = parsed.routerModels?.[slug];
        if (models === undefined) continue;
        try {
            await replaceUserRouterModels(userId, slug, models, db);
        } catch (routerModelsError) {
            return void sendInternalError(res, routerModelsError);
        }
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return void sendInternalError(res, error);
    res.json({ ...data, apiKeyStatus });
});

// POST /user/onboarding
userRouter.post("/onboarding", requireAuth, async (req, res) => {
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : null;
    if (!body) {
        return void res.status(400).json({ detail: "Expected a JSON object" });
    }

    const invalidField = Object.keys(body).find(
        (key) =>
            key !== "jurisdiction" &&
            key !== "practiceSetting" &&
            key !== "professionalTitle" &&
            key !== "practiceAreas",
    );
    if (invalidField) {
        return void res.status(400).json({
            detail: `Unsupported onboarding field: ${invalidField}`,
        });
    }

    const personalisation = parsePersonalisationPayload(body, {
        allowClearing: false,
    });
    if (!personalisation.ok) {
        return void res.status(400).json({ detail: personalisation.detail });
    }
    const personalisationUpdate = personalisation.update;

    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) {
        return void res.status(500).json({ detail: ensureError.message });
    }

    const { error: updateError } = await db
        .from("user_profiles")
        .update({
            ...personalisationUpdate,
            onboarding_version: 1,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (updateError) {
        return void res.status(500).json({ detail: updateError.message });
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ ...data, apiKeyStatus });
});

// POST /user/security/password-set
// Record password capability only after verifying Supabase's auth.users row.
userRouter.post("/security/password-set", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) {
        return void res.status(500).json({ detail: ensureError.message });
    }

    const { data: passwordSetAt, error: syncError } = await db.rpc(
        "sync_user_password_set",
        { p_user_id: userId },
    );
    if (syncError) {
        return void res.status(500).json({ detail: syncError.message });
    }
    if (!passwordSetAt) {
        return void res.status(409).json({
            detail: "Supabase has not recorded a password for this account",
        });
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ ...data, apiKeyStatus });
});

// PATCH /user/security/mfa-login
userRouter.patch(
    "/security/mfa-login",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerSupabase();
        if (parsed.value) {
            const factorCheck = await userHasVerifiedTotpFactor(db, userId);
            if (!factorCheck.ok) {
                return void sendInternalError(res, factorCheck.error);
            }
            if (!factorCheck.hasVerifiedTotp) {
                return void res.status(400).json({
                    detail: "Set up an authenticator app before requiring verification on login.",
                });
            }
        }

        const ensureError = await ensureProfileRow(db, userId);
        if (ensureError)
            return void sendInternalError(res, ensureError);

        const { error: updateError } = await db
            .from("user_profiles")
            .update({
                mfa_on_login: parsed.value,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        if (updateError)
            return void sendInternalError(res, updateError);

        const apiKeyStatus = await getUserApiKeyStatus(userId, db);
        const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
        if (error) return void sendInternalError(res, error);
        res.json({ ...data, apiKeyStatus });
    },
);

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const status = await getUserApiKeyStatus(userId, db);
    res.json(status);
});

// PUT /user/api-keys/:provider
userRouter.put(
    "/api-keys/:provider",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider)
            return void res
                .status(400)
                .json({ detail: "Unsupported provider" });

        const apiKey =
            typeof req.body?.api_key === "string" ? req.body.api_key : null;
        const db = createServerSupabase();
        try {
            if (hasEnvApiKey(provider)) {
                return void res.status(409).json({
                    detail: "This provider is configured by the server environment and cannot be changed from the browser.",
                });
            }
            await saveUserApiKey(userId, provider, apiKey, db);
            const status = await getUserApiKeyStatus(userId, db);
            res.json(status);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/api-keys] save failed", {
                provider,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// GET /user/mcp-connectors
userRouter.get("/mcp-connectors", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        res.json(
            await listUserMcpConnectors(userId, db, { includeTools: false }),
        );
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] list failed", {
            userId,
            error: detail,
        });
        sendInternalError(res, err);
    }
});

// GET /user/mcp-connectors/:connectorId
userRouter.get(
    "/mcp-connectors/:connectorId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            res.json(
                await getUserMcpConnector(userId, req.params.connectorId, db),
            );
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] get failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(404).json({ detail: "Connector not found" });
        }
    },
);

// POST /user/mcp-connectors
userRouter.post(
    "/mcp-connectors",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const name = typeof req.body?.name === "string" ? req.body.name : "";
        const serverUrl =
            typeof req.body?.serverUrl === "string" ? req.body.serverUrl : "";
        const bearerToken =
            typeof req.body?.bearerToken === "string"
                ? req.body.bearerToken
                : null;
        const headers =
            req.body?.headers &&
            typeof req.body.headers === "object" &&
            !Array.isArray(req.body.headers)
                ? (req.body.headers as Record<string, unknown>)
                : undefined;
        const db = createServerSupabase();
        try {
            const connector = await createUserMcpConnector(
                userId,
                { name, serverUrl, bearerToken, headers },
                db,
            );
            res.status(201).json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] create failed", {
                userId,
                error: detail,
            });
            res.status(400).json({
                detail: "Connector settings are invalid or the server could not be reached.",
            });
        }
    },
);

// PATCH /user/mcp-connectors/:connectorId
userRouter.patch(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const body = req.body ?? {};
        try {
            const connector = await updateUserMcpConnector(
                userId,
                req.params.connectorId,
                {
                    ...(typeof body.name === "string"
                        ? { name: body.name }
                        : {}),
                    ...(typeof body.serverUrl === "string"
                        ? { serverUrl: body.serverUrl }
                        : {}),
                    ...(typeof body.enabled === "boolean"
                        ? { enabled: body.enabled }
                        : {}),
                    ...("bearerToken" in body
                        ? {
                              bearerToken:
                                  typeof body.bearerToken === "string"
                                      ? body.bearerToken
                                      : null,
                          }
                        : {}),
                    ...("headers" in body
                        ? {
                              headers:
                                  body.headers &&
                                  typeof body.headers === "object" &&
                                  !Array.isArray(body.headers)
                                      ? (body.headers as Record<
                                            string,
                                            unknown
                                        >)
                                      : {},
                          }
                        : {}),
                },
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] update failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(400).json({
                detail: "Connector settings are invalid or the server could not be reached.",
            });
        }
    },
);

// DELETE /user/mcp-connectors/:connectorId
userRouter.delete(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteUserMcpConnector(userId, req.params.connectorId, db);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] delete failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// POST /user/mcp-connectors/:connectorId/oauth/start
userRouter.post(
    "/mcp-connectors/:connectorId/oauth/start",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            const redirectUri = `${backendPublicUrl(req)}/user/mcp-connectors/oauth/callback`;
            const result = await startUserMcpConnectorOAuth(
                userId,
                req.params.connectorId,
                redirectUri,
                db,
            );
            res.json({
                ...result,
                callbackOrigin: new URL(redirectUri).origin,
            });
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] oauth start failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(400).json({
                detail: "Connector authorization could not be started.",
            });
        }
    },
);

// GET /user/mcp-connectors/oauth/callback
userRouter.get("/mcp-connectors/oauth/callback", async (req, res) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const error =
        typeof req.query.error === "string" ? req.query.error : undefined;
    const db = createServerSupabase();
    try {
        if (error) throw new Error(error);
        if (!state || !code)
            throw new Error("OAuth callback is missing state or code.");
        const result = await completeUserMcpConnectorOAuth(state, code, db);
        res.set(mcpOAuthPopupHeaders(nonce))
            .type("html")
            .send(
                mcpOAuthPopupHtml(
                    {
                        success: true,
                        connectorId: result.connectorId,
                    },
                    nonce,
                ),
            );
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] oauth callback failed", {
            error: detail,
            stateHash: shortHash(state),
            hasCode: !!code,
            hasError: !!error,
            issuer:
                typeof req.query.iss === "string" ? req.query.iss : undefined,
            scope:
                typeof req.query.scope === "string"
                    ? req.query.scope
                    : undefined,
        });
        res.status(400)
            .set(mcpOAuthPopupHeaders(nonce))
            .type("html")
            .send(
                mcpOAuthPopupHtml(
                    {
                        success: false,
                        detail: "Connector authorization could not be completed.",
                    },
                    nonce,
                ),
            );
    }
});

// POST /user/mcp-connectors/:connectorId/refresh-tools
userRouter.post(
    "/mcp-connectors/:connectorId/refresh-tools",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            const connector = await refreshUserMcpConnectorTools(
                userId,
                req.params.connectorId,
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] refresh failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            if (err instanceof McpOAuthRequiredError) {
                return void res.status(401).json({
                    code: err.code,
                    detail: "This connector needs to be authorized again.",
                });
            }
            res.status(400).json({
                detail: "Connector tools could not be refreshed.",
            });
        }
    },
);

// PATCH /user/mcp-connectors/:connectorId/tools/:toolId
userRouter.patch(
    "/mcp-connectors/:connectorId/tools/:toolId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerSupabase();
        try {
            const connector = await setUserMcpToolEnabled(
                userId,
                req.params.connectorId,
                req.params.toolId,
                parsed.value,
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] tool toggle failed", {
                userId,
                connectorId: req.params.connectorId,
                toolId: req.params.toolId,
                error: detail,
            });
            res.status(400).json({
                detail: "Connector tool settings could not be updated.",
            });
        }
    },
);

// DELETE /user/account
userRouter.delete(
    "/account",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            await deleteUserAccountData(db, userId, userEmail);
            const { error } = await db.auth.admin.deleteUser(userId);
            if (error)
                return void sendInternalError(res, error);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/account] delete failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// DELETE /user/chats
userRouter.delete(
    "/chats",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteAllUserChats(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/chats] delete failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// DELETE /user/projects
userRouter.delete(
    "/projects",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteUserProjects(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/projects] delete failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// DELETE /user/tabular-reviews
userRouter.delete(
    "/tabular-reviews",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteAllUserTabularReviews(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/tabular-reviews] delete failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// GET /user/export
userRouter.get(
    "/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            const data = await buildUserAccountExport(db, userId, userEmail);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("account", userId)}"`,
            );
            void recordAudit(createServerSupabase(), {
                userId,
                userEmail: res.locals.userEmail as string | undefined,
                action: "export.account",
                surface: "account",
            });
            res.json(data);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/export] failed", { userId, error: detail });
            sendInternalError(res, err);
        }
    },
);

// GET /user/chats/export
userRouter.get(
    "/chats/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            const data = await buildUserChatsExport(db, userId, userEmail);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("chats", userId)}"`,
            );
            void recordAudit(createServerSupabase(), {
                userId,
                userEmail: res.locals.userEmail as string | undefined,
                action: "export.chats",
                surface: "account",
            });
            res.json(data);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/chats/export] failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// GET /user/tabular-reviews/export
userRouter.get(
    "/tabular-reviews/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            const data = await buildUserTabularReviewsExport(
                db,
                userId,
                userEmail,
            );
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("tabular-reviews", userId)}"`,
            );
            void recordAudit(createServerSupabase(), {
                userId,
                userEmail: res.locals.userEmail as string | undefined,
                action: "export.tabular",
                surface: "account",
            });
            res.json(data);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/tabular-reviews/export] failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);
