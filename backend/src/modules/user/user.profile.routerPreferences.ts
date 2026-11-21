import type { RouterSlug } from "../../lib/routerModels";
export { normalizeRouterModels } from "../../lib/routerModelValidation";

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
