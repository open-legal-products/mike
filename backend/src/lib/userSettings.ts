import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    type UserApiKeys,
} from "./llm";
import { getUserApiKeys as getStoredUserApiKeys } from "./userApiKeys";
import { getUserCommittees } from "./userCommittees";
import type { CommitteeModel } from "./llm/types";
import {
    getAllUserRouterModels,
    isRouterModelSelected,
    ROUTER_SLUGS,
    routerForModelId,
    type RouterModelSelections,
} from "./routerModels";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
    committees: CommitteeModel[];
    personalisation?: {
        displayName: string | null;
        organisation: string | null;
        jurisdiction: string | null;
        practiceSetting: string | null;
        professionalTitle: string | null;
        practiceAreas: string[];
    };
};

// Title generation is a lightweight task — always routed to the cheapest model
// of whichever provider the user has keys for: Gemini Flash Lite if Gemini is
// available, otherwise OpenAI lite, Claude Haiku, or the user's first saved
// router model. With no usable provider, defaults to Gemini (the dev-mode env
// fallback).
function resolveTitleModel(
    apiKeys: UserApiKeys,
    routerModels: RouterModelSelections,
): string {
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    for (const slug of ROUTER_SLUGS) {
        const first = routerModels[slug][0];
        if (apiKeys[slug]?.trim() && first) return `${slug}/${first}`;
    }
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const [profileResult, api_keys, routerModels, committees] =
        await Promise.all([
        client
            .from("user_profiles")
            .select(
                "title_model, tabular_model, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single(),
        getStoredUserApiKeys(userId, client),
        getAllUserRouterModels(userId, client),
        getUserCommittees(userId, client),
    ]);
    let data = profileResult.data;

    // A database that predates the 20260821 onboarding migration rejects the
    // select above outright (unknown column), which would silently fall every
    // caller back to default models and re-enable US legal research for users
    // who turned it off. Retry with the pre-migration column set so saved
    // settings keep working; personalisation simply stays empty.
    if (profileResult.error?.code === "42703") {
        const legacy = await client
            .from("user_profiles")
            .select("title_model, tabular_model, legal_research_us")
            .eq("user_id", userId)
            .single();
        // A second failure (a database even older than the pre-migration
        // shape) keeps data null and falls through to the defaults below —
        // the pre-retry behavior, now explicit instead of accidental.
        data = legacy.error ? null : (legacy.data as typeof data);
    }

    // A stored preference can name a router model the user has since removed
    // from (or never had in) their saved selection — e.g. a hand-crafted
    // profile PATCH. Treat that exactly like an invalid model id and fall
    // back, so the env-key spend path can't be steered onto arbitrary
    // gateway models.
    const guardRouterModel = (model: string, fallback: string): string => {
        if (
            !routerForModelId(model) ||
            isRouterModelSelected(model, routerModels)
        ) {
            return model;
        }
        console.warn(
            `[router-models] user ${userId} preference "${model}" is outside their saved selection; using ${fallback}`,
        );
        return fallback;
    };
    const titleFallback = resolveTitleModel(api_keys, routerModels);

    return {
        committees,
        title_model: guardRouterModel(
            resolveModel(data?.title_model, titleFallback, committees),
            titleFallback,
        ),
        tabular_model: guardRouterModel(
            resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL, committees),
            DEFAULT_TABULAR_MODEL,
        ),
        legal_research_us:
            (data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
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
        },
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    return getStoredUserApiKeys(userId, client);
}
