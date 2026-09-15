// user profile validation — implementation behind the module facade.
// User profile: load, serialize, validate, bootstrap, read + update.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract (explicit `db`, request-derived primitives in, typed result objects
// out, no req/res). The profile-row loaders (ensureProfileRow / loadProfile)
// are exported for intra-module reuse by user.mfa.ts; the facade does NOT
// re-export them, so they stay off the module's public surface.
import { REASONING_LEVELS, resolveModel } from "../../lib/llm";
import { ROUTER_SLUGS, type RouterSlug } from "../../lib/routerModels";
import { ROUTER_PROFILE_FIELDS, normalizeRouterModels } from "./user.profile.routerPreferences";

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
              memory_curator_model?: string | null;
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
        "memoryCuratorModel",
        "lastSelectedChatModel",
        "lastSelectedReasoningLevel",
        "legalResearchUs",
        "quickActionsVisible",
        "darkMode",
        "projectMemoryDefault",
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
        memory_curator_model?: string | null;
        last_selected_chat_model?: string | null;
        last_selected_reasoning_level?: string | null;
        legal_research_us?: boolean;
        quick_actions_visible?: boolean;
        dark_mode?: boolean;
        project_memory_default?: boolean;
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

    if ("memoryCuratorModel" in raw) {
        if (
            raw.memoryCuratorModel === null ||
            raw.memoryCuratorModel === ""
        ) {
            update.memory_curator_model = null;
        } else if (typeof raw.memoryCuratorModel !== "string") {
            return {
                ok: false,
                detail: "memoryCuratorModel must be a string or null",
            };
        } else {
            const resolved = resolveModel(raw.memoryCuratorModel, "");
            if (!resolved) {
                return {
                    ok: false,
                    detail: "Unsupported memoryCuratorModel",
                };
            }
            update.memory_curator_model = resolved;
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

    if ("projectMemoryDefault" in raw) {
        if (typeof raw.projectMemoryDefault !== "boolean") {
            return {
                ok: false,
                detail: "projectMemoryDefault must be a boolean",
            };
        }
        update.project_memory_default = raw.projectMemoryDefault;
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
