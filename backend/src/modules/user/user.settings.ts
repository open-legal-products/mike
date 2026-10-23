import { createServerSupabase, type Db } from "../../lib/supabase";
import { type UserApiKeys } from "../../lib/llm";
import { type ReasoningLevel } from "../../lib/llm";
import {
    getEffectiveApiKeys,
    loadCourtListenerConnection,
} from "./user.apiKeyStore";
import { courtlistenerBulkDataEnabled } from "../../lib/courtlistener";
import { loadCustomInstructions } from "./user.customInstructions";
import {
    DEFAULT_RESPONSE_STYLE,
    loadResponseStyle,
    type ResponseStyle,
} from "./user.responseStyle";
import { loadWebSearchSettings } from "./user.webSearch";
import {
    DEFAULT_WEB_SEARCH_SETTINGS,
    type WebSearchSettings,
} from "../../lib/webSearch";
import { safeError } from "../../lib/safeError";
import { getEffectiveRouterModels } from "../../lib/routerModels";
import {
    normalizeOptionalModelPreference,
    normalizeReasoningLevel,
} from "../../lib/modelSelection";

export type UserModelSettings = {
    /** Explicit override; null means derive the title model from the chat. */
    title_model: string | null;
    /** Default for new reviews only; each review stores its own model. */
    tabular_model: string | null;
    /** Explicit override for asynchronous memory curation. */
    memory_curator_model: string | null;
    /** Told to the assistant as defaults for its subagents; never enforced. */
    subagent_model: string | null;
    subagent_reasoning: ReasoningLevel | null;
    /** Cross-surface fallback used only when a chat has no usable model. */
    last_selected_chat_model: string | null;
    /** Cross-surface fallback used only when a chat has no saved level. */
    last_selected_reasoning_level: ReasoningLevel | null;
    /**
     * Whether the assistant gets the CourtListener tools: the user's switch is
     * on and the connector is usable, through a saved token or the
     * deployment's bulk index.
     */
    legal_research_us: boolean;
    web_search: WebSearchSettings;
    api_keys: UserApiKeys;
    personalisation?: {
        displayName: string | null;
        organisation: string | null;
        jurisdiction: string | null;
        practiceSetting: string | null;
        professionalTitle: string | null;
        practiceAreas: string[];
        /** Free-form instructions from Settings > Personalisation. */
        customInstructions?: string;
        /** Response style from Settings > Personalisation. */
        responseStyle?: ResponseStyle;
    };
};

/**
 * `options.orgId` is the organization the work belongs to, when it belongs
 * to one: the keys it runs on are then the organization's, with a member's
 * own keys beneath them only if the organization allows that (see
 * getEffectiveApiKeys), and the saved model preferences are judged against
 * the lists that govern those keys (getEffectiveRouterModels). Everything
 * else here is the person's own, whichever workspace they are in.
 */
export async function getUserModelSettings(
    userId: string,
    db?: Db,
    options: { orgId?: string | null } = {},
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const [
        profileResult,
        api_keys,
        routerModels,
        customInstructions,
        responseStyle,
        webSearch,
        courtListener,
    ] = await Promise.all([
        client
            .from("user_profiles")
            .select(
                "title_model, tabular_model, memory_curator_model, subagent_model, subagent_reasoning, last_selected_chat_model, last_selected_reasoning_level, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single(),
        getEffectiveApiKeys(userId, options.orgId, client),
        getEffectiveRouterModels(userId, options.orgId, client),
        // Instructions are an enhancement: a failed read must not block chat.
        loadCustomInstructions(client, userId).catch((error: unknown) => {
            console.error(
                "[user-settings] custom instructions load failed",
                safeError(error),
            );
            return "";
        }),
        loadResponseStyle(client, userId).catch((error: unknown) => {
            console.error(
                "[user-settings] response style load failed",
                safeError(error),
            );
            return DEFAULT_RESPONSE_STYLE;
        }),
        loadWebSearchSettings(client, userId).catch((error: unknown) => {
            console.error(
                "[user-settings] web search settings load failed",
                safeError(error),
            );
            return DEFAULT_WEB_SEARCH_SETTINGS;
        }),
        // The CourtListener switch is per workspace, like the connector.
        // Research is an enhancement: a failed read leaves it off.
        loadCourtListenerConnection(
            { userId, orgId: options.orgId ?? null },
            client,
        ).catch((error: unknown) => {
            console.error(
                "[user-settings] CourtListener connection load failed",
                safeError(error),
            );
            return { enabled: false, token: null };
        }),
    ]);
    let data = profileResult.data;
    let profileError = profileResult.error;

    // Deploy-before-migrate tolerance for the subagent defaults.
    if (
        profileError?.code === "42703" &&
        typeof profileError.message === "string" &&
        profileError.message.includes("subagent_")
    ) {
        const withoutSubagentDefaults = await client
            .from("user_profiles")
            .select(
                "title_model, tabular_model, memory_curator_model, last_selected_chat_model, last_selected_reasoning_level, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single();
        if (!withoutSubagentDefaults.error) {
            data = {
                ...withoutSubagentDefaults.data,
                subagent_model: null,
                subagent_reasoning: null,
            } as typeof data;
            profileError = null;
        } else {
            profileError = withoutSubagentDefaults.error;
        }
    }

    // Deploy-before-migrate tolerance for the memory curator preference. Keep
    // every previously available setting while the new nullable column is
    // still being rolled out.
    if (
        profileError?.code === "42703" &&
        typeof profileError.message === "string" &&
        profileError.message.includes("memory_curator_model")
    ) {
        const withoutMemoryCuratorModel = await client
            .from("user_profiles")
            .select(
                "title_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single();
        if (!withoutMemoryCuratorModel.error) {
            data = {
                ...withoutMemoryCuratorModel.data,
                memory_curator_model: null,
            } as typeof data;
            profileError = null;
        } else {
            profileError = withoutMemoryCuratorModel.error;
        }
    }

    // A database that predates the 20260821 onboarding migration rejects the
    // select above outright (unknown column), which would silently fall every
    // caller back to default models and re-enable US legal research for users
    // who turned it off. Retry with the pre-migration column set so saved
    // settings keep working; personalisation simply stays empty.
    if (profileError?.code === "42703") {
        const withoutLastSelected = await client
            .from("user_profiles")
            .select(
                "title_model, tabular_model, last_selected_chat_model, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single();
        if (!withoutLastSelected.error) {
            data = {
                ...withoutLastSelected.data,
                memory_curator_model: null,
                last_selected_reasoning_level: null,
            } as typeof data;
        } else if (withoutLastSelected.error.code === "42703") {
            const legacy = await client
                .from("user_profiles")
                .select("title_model, tabular_model")
                .eq("user_id", userId)
                .single();
            // A second failure (a database even older than the pre-migration
            // shape) keeps data null and falls through to the defaults below.
            data = legacy.error
                ? null
                : ({
                      ...legacy.data,
                      memory_curator_model: null,
                      last_selected_chat_model: null,
                      last_selected_reasoning_level: null,
                  } as typeof data);
        } else {
            data = null;
        }
    }

    return {
        title_model: normalizeOptionalModelPreference(
            data?.title_model,
            routerModels,
        ),
        tabular_model: normalizeOptionalModelPreference(
            data?.tabular_model,
            routerModels,
        ),
        memory_curator_model: normalizeOptionalModelPreference(
            data?.memory_curator_model,
            routerModels,
        ),
        subagent_model: normalizeOptionalModelPreference(
            data?.subagent_model,
            routerModels,
        ),
        subagent_reasoning: normalizeReasoningLevel(data?.subagent_reasoning),
        last_selected_chat_model: normalizeOptionalModelPreference(
            data?.last_selected_chat_model,
            routerModels,
        ),
        last_selected_reasoning_level: normalizeReasoningLevel(
            data?.last_selected_reasoning_level,
        ),
        legal_research_us:
            courtListener.enabled &&
            (!!api_keys.courtlistener || courtlistenerBulkDataEnabled()),
        web_search: webSearch,
        personalisation: {
            displayName:
                typeof data?.display_name === "string"
                    ? data.display_name
                    : null,
            organisation:
                typeof data?.organisation === "string"
                    ? data.organisation
                    : null,
            jurisdiction:
                typeof data?.jurisdiction === "string"
                    ? data.jurisdiction
                    : null,
            practiceSetting:
                typeof data?.practice_setting === "string"
                    ? data.practice_setting
                    : null,
            professionalTitle:
                typeof data?.professional_title === "string"
                    ? data.professional_title
                    : null,
            practiceAreas: Array.isArray(data?.practice_areas)
                ? data.practice_areas.filter(
                      (area): area is string => typeof area === "string",
                  )
                : [],
            customInstructions,
            responseStyle,
        },
        api_keys,
    };
}

/** Save a reasoning level when the user explicitly selects it in a picker. */
export async function persistLastSelectedReasoningLevel(
    userId: string,
    reasoningLevel: ReasoningLevel,
    db: Db,
): Promise<unknown | null> {
    const { error } = await db
        .from("user_profiles")
        .update({
            last_selected_reasoning_level: reasoningLevel,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    return error ?? null;
}

/** Save a model when the user explicitly selects it in a chat picker. */
export async function persistLastSelectedChatModel(
    userId: string,
    model: string,
    db: Db,
): Promise<unknown | null> {
    const { error } = await db
        .from("user_profiles")
        .update({
            last_selected_chat_model: model,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    return error ?? null;
}
