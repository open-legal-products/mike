import { providerForModel } from "../llm/models";
import type {
    WebSearchBackend,
    WebSearchFamily,
    WebSearchSettings,
} from "./settings";
import type { WebSearchAccount } from "./types";

export type WebSearchPlan = "provider" | WebSearchBackend;

export type WebSearchKeys = Partial<Record<WebSearchBackend, string | null>>;

// Gemini has a search tool too, but Google requires its search suggestions to
// be shown wherever results are used, so Mike does not offer it.
function familyOf(model: string): WebSearchFamily {
    try {
        const provider = providerForModel(model);
        if (provider === "claude" || provider === "openai") return provider;
    } catch {
        // An unknown model has no provider search of its own.
    }
    return "other";
}

export function webSearchPlanFor(
    settings: WebSearchSettings,
    model: string,
    keys: WebSearchKeys | null | undefined,
): WebSearchPlan | null {
    if (!settings.enabled) return null;
    const choice = settings[familyOf(model)];
    if (choice === "off") return null;
    if (choice === "provider") return "provider";
    return keys?.[choice] ? choice : null;
}

/** Mike's search service for a plan, or null when the model searches by itself. */
export function webSearchAccountFor(
    plan: WebSearchPlan | null,
    keys: WebSearchKeys | null | undefined,
): WebSearchAccount | null {
    if (!plan || plan === "provider") return null;
    const apiKey = keys?.[plan];
    return apiKey ? { backend: plan, apiKey } : null;
}
