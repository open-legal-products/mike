// user profile serialization — implementation behind the module facade.
import { normalizeOptionalModelPreference, normalizeReasoningLevel } from "../../lib/modelSelection";
import { type ApiKeyStatus } from "./user.apiKeyStore";
import { ROUTER_SLUGS, type RouterModelSelections } from "../../lib/routerModels";
import { UserProfileRow, MONTHLY_CREDIT_LIMIT } from "./user.profile.storage";

import { ROUTER_PROFILE_FIELDS } from "./user.profile.routerPreferences";

export function serializeProfile(
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
        memoryCuratorModel: normalizeOptionalModelPreference(
            row.memory_curator_model,
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
        projectMemoryDefault: row.project_memory_default !== false,
        ...Object.fromEntries(
            ROUTER_SLUGS.map((slug) => [
                ROUTER_PROFILE_FIELDS[slug],
                routerModels[slug],
            ]),
        ),
        ...(apiKeyStatus ? { apiKeyStatus } : {}),
    };
}
