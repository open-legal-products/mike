// The routers a user can save models for, and how their selections map onto
// the profile. Kept free of React and of component imports so every consumer
// (pickers, settings, hooks, the profile context) can share it.

/**
 * Router slugs, which double as model-id prefixes and API-key provider names.
 * Kept in sync with backend/src/lib/routerModels.ts ROUTER_SLUGS.
 */
export const ROUTER_SLUGS = [
    "openrouter",
    "vercel",
    "opencode-go",
    "bedrock",
    "azure",
    "azure-foundry",
    "vertex",
    "xai",
    "custom",
] as const;
export type RouterSlug = (typeof ROUTER_SLUGS)[number];

/** Saved model ids per router; a router with none may be absent. */
export type RouterModelSelections = Partial<Record<RouterSlug, string[]>>;

/**
 * The profile field each router's selection is read from and written to.
 * Mirrors the backend's ROUTER_PROFILE_FIELDS.
 */
export const ROUTER_PROFILE_FIELDS = {
    openrouter: "openRouterModels",
    vercel: "vercelModels",
    "opencode-go": "openCodeGoModels",
    bedrock: "bedrockModels",
    azure: "azureModels",
    "azure-foundry": "azureFoundryModels",
    vertex: "vertexModels",
    xai: "xaiModels",
    custom: "customModels",
} as const satisfies Record<RouterSlug, string>;

export type RouterProfileField =
    (typeof ROUTER_PROFILE_FIELDS)[RouterSlug];

/** Every router's saved models, read from a profile's per-router fields. */
export function routerModelsFromProfile(
    profile:
      | Partial<Record<RouterProfileField, string[] | null | undefined>>
      | null
      | undefined,
): Record<RouterSlug, string[]> {
    return Object.fromEntries(
      ROUTER_SLUGS.map((slug) => {
        const models = profile?.[ROUTER_PROFILE_FIELDS[slug]];
        return [slug, Array.isArray(models) ? models : []];
      }),
    ) as Record<RouterSlug, string[]>;
}
