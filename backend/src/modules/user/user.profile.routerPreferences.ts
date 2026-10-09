// user profile routerPreferences — implementation behind the module facade.
// User profile: load, serialize, validate, bootstrap, read + update.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract (explicit `db`, request-derived primitives in, typed result objects
// out, no req/res). The profile-row loaders (ensureProfileRow / loadProfile)
// are exported for intra-module reuse by user.mfa.ts; the facade does NOT
// re-export them, so they stay off the module's public surface.
import { isSupportedOpenCodeGoModel } from "../../lib/llm";
import { type RouterSlug } from "../../lib/routerModels";

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
    // Account-specific ids with no published catalog: Bedrock model and
    // inference-profile ids ("us.anthropic.claude-opus-5-5", ARNs) and Azure
    // deployment names.
    bedrock: /^[^\s]+$/,
    azure: /^[^\s]+$/,
    // Foundry deployment names, Vertex model ids ("gemini-3.1-pro-preview",
    // "claude-opus-5-5@20260101", "meta/llama-4-maverick-maas"), xAI model
    // names and whatever a custom endpoint calls its models.
    "azure-foundry": /^[^\s]+$/,
    vertex: /^[^\s]+$/,
    xai: /^[^\s]+$/,
    custom: /^[^\s]+$/,
};

/**
 * The profile field each router's selection is read from and written to.
 * Mirrored by the frontend's updateUserProfile payload.
 */
export const ROUTER_PROFILE_FIELDS: Record<RouterSlug, string> = {
    openrouter: "openRouterModels",
    vercel: "vercelModels",
    "opencode-go": "openCodeGoModels",
    bedrock: "bedrockModels",
    azure: "azureModels",
    "azure-foundry": "azureFoundryModels",
    vertex: "vertexModels",
    xai: "xaiModels",
    custom: "customModels",
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
