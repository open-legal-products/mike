import { createServerSupabase } from "./supabase";
import { UserFacingError } from "./userFacingError";
import type { Db } from "./supabase";
import { ACCOUNT_MODEL_LABELS, resolveModel } from "./llm/models";
import { getConfiguredModel } from "./llm/registry";

export type RouterSlug =
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "bedrock"
    | "azure"
    | "azure-foundry"
    | "vertex"
    | "xai"
    | "custom";

/**
 * Every router, in the order the settings UI lists them. A router's slug is
 * also its model-id prefix and its API-key provider name — keeping those one
 * string is what lets the selection, gating and key lookups stay generic.
 */
export const ROUTER_SLUGS: readonly RouterSlug[] = [
    "openrouter",
    "vercel",
    "opencode-go",
    "bedrock",
    "azure",
    "azure-foundry",
    "vertex",
    "xai",
    "custom",
];

/** One saved model selection per router. */
export type RouterModelSelections = Record<RouterSlug, string[]>;

/** The router a namespaced app-level model id routes through, if any. */
export function routerForModelId(model: string): RouterSlug | null {
    // Deployment-declared models win over the prefix rules, exactly as in
    // providerForModel: an operator's MIKE_MODEL_CONFIG_JSON model named
    // "azure/gpt-internal" is an openai-compatible endpoint, not an Azure
    // OpenAI deployment, and is not gated by the user's router selection.
    if (getConfiguredModel(model)) return null;
    // "azure-foundry/" does not start with "azure/", so no slug shadows
    // another; the trailing slash is what keeps that true.
    return ROUTER_SLUGS.find((slug) => model.startsWith(`${slug}/`)) ?? null;
}

/**
 * True when a router-prefixed model id is in the user's saved selection for
 * that router (selections store the raw catalog id, without the slug prefix).
 * Non-router models are always allowed here — their gating happens elsewhere.
 */
export function isRouterModelSelected(
    model: string,
    selections: RouterModelSelections,
): boolean {
    const router = routerForModelId(model);
    if (!router) return true;
    return selections[router].includes(model.slice(router.length + 1));
}

/** Router labels as the settings UI names them, for user-facing messages. */
const ROUTER_LABELS: Record<RouterSlug, string> = {
    openrouter: "OpenRouter",
    vercel: "Vercel AI Gateway",
    "opencode-go": "OpenCode Go",
    ...ACCOUNT_MODEL_LABELS,
};

/**
 * Request-time model resolution for chat-style requests. Router-prefixed ids
 * are accepted by SHAPE in resolveModel, so on their own they would let any
 * authenticated user hand-craft a request that runs an arbitrary, arbitrarily
 * expensive gateway model on the operator's env key. This choke point
 * additionally requires a router model to be in the saved selection that
 * governs the key it would run on: the organization's, when the work belongs
 * to one that holds this router's key (`orgId`), and otherwise the
 * requesting user's.
 *
 * `onOutsideSelection` picks what "not in the selection" means to the caller:
 * - "throw" (the request path): the user named this model in THIS request, so
 *   quietly answering with a different one is a lie about which model wrote
 *   the response. Fail loudly with an actionable message instead.
 * - "fallback" (the default, for stored preferences): a preference the user
 *   set long ago must not brick every request; degrade to the caller's
 *   default exactly like an invalid model id, with a warning for operators.
 */
export async function resolveRequestedModel(
    requested: string | null | undefined,
    fallback: string,
    userId: string,
    db: Db = createServerSupabase(),
    onOutsideSelection: "throw" | "fallback" = "fallback",
    orgId?: string | null,
): Promise<string> {
    const resolved = resolveModel(requested, fallback);
    const router = routerForModelId(resolved);
    if (!router) return resolved;
    const fromOrganization =
        !!orgId && (await orgRouterKeyOwners(userId, orgId, db)).has(router);
    const selection = fromOrganization
        ? await getOrgRouterModels(orgId, router, db)
        : await getUserRouterModels(userId, router, db);
    if (selection.includes(resolved.slice(router.length + 1))) {
        return resolved;
    }
    if (onOutsideSelection === "throw") {
        throw new UserFacingError(
            fromOrganization
                ? `Model ${resolved} is not in your organization's saved ${ROUTER_LABELS[router]} models — an organization admin can add it in Organization Settings.`
                : `Model ${resolved} is not in your saved ${ROUTER_LABELS[router]} models — open ${ROUTER_LABELS[router]} in Settings → Bring Your Own Keys and add it under Model Selections.`,
        );
    }
    console.warn(
        `[router-models] user ${userId} requested ${router} model "${resolved}" outside their saved selection; using ${fallback}`,
    );
    return fallback;
}

// Deploy-before-migrate tolerance: on a database that predates the
// user_router_models migration, reads report "no selections" instead of
// exploding every profile/chat/title/tabular request into a 500. Postgres
// raises undefined_table (42P01); PostgREST reports a relation missing from
// its schema cache as PGRST205 (the analog of the 42703 missing-column shape
// selectProfile already tolerates).
//
// BOTH arms require the message to name user_router_models. Neither code
// means "THIS table is missing" on its own — a policy, view or trigger that
// references some other dropped relation raises 42P01 from this query too,
// and answering that with an empty selection would turn a schema fault into
// a silent "you have no router models".
function isMissingRouterModelsTable(error: unknown): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    return (
        (code === "42P01" || code === "PGRST205") &&
        message.includes("user_router_models")
    );
}

let warnedMissingTable = false;

/** Every router's saved selection for a user, in one round of queries. */
export async function getAllUserRouterModels(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<RouterModelSelections> {
    const selections = await Promise.all(
        ROUTER_SLUGS.map((slug) => getUserRouterModels(userId, slug, db)),
    );
    return Object.fromEntries(
        ROUTER_SLUGS.map((slug, index) => [slug, selections[index]]),
    ) as RouterModelSelections;
}

export async function getUserRouterModels(
    userId: string,
    router: string,
    db: Db = createServerSupabase(),
): Promise<string[]> {
    const { data, error } = await db
        .from("user_router_models")
        .select("model_id")
        .eq("user_id", userId)
        .eq("router", router)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
    if (error) {
        if (isMissingRouterModelsTable(error)) {
            if (!warnedMissingTable) {
                warnedMissingTable = true;
                console.warn(
                    "[router-models] user_router_models table is missing; " +
                        "treating router selections as empty until the " +
                        "20260818_01 migration is applied",
                );
            }
            return [];
        }
        throw error;
    }

    return (data ?? []).flatMap((row) =>
        typeof row.model_id === "string" && row.model_id.trim()
            ? [row.model_id.trim()]
            : [],
    );
}

// ---------------------------------------------------------------------------
// An organization's own lists
//
// A router's list belongs to whoever's key it runs on. Where an organization
// holds a key for the router (a row in org_api_keys, switched on or off), its
// admins decide which models that key may run, for every member. Where it
// holds none, the member's own list applies, to their own key or the
// deployment's, exactly as it does for personal work.
// ---------------------------------------------------------------------------

// Deploy-before-migrate tolerance for 20261012_02 / 20261012_03: until they
// land, an organization holds no keys and no lists, and every member runs on
// their own. Same two shapes as above (direct connection, PostgREST cache),
// each required to name one of the organization tables.
function isMissingOrgRouterSchema(error: unknown): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    return (
        (code === "42P01" || code === "PGRST205") &&
        (message.includes("org_router_models") ||
            message.includes("org_api_keys"))
    );
}

/**
 * The routers whose key `orgId` holds, as far as `userId` is concerned:
 * empty when they are not a member, so an id alone never puts somebody
 * under an organization's list.
 */
async function orgRouterKeyOwners(
    userId: string,
    orgId: string,
    db: Db,
): Promise<Set<RouterSlug>> {
    const [membership, keys] = await Promise.all([
        db
            .from("org_members")
            .select("org_id, organizations!inner(id)")
            .is("organizations.deleted_at", null)
            .eq("org_id", orgId)
            .eq("user_id", userId)
            .maybeSingle(),
        db.from("org_api_keys").select("provider").eq("org_id", orgId),
    ]);
    if (membership.error) throw membership.error;
    if (keys.error) {
        if (isMissingOrgRouterSchema(keys.error)) return new Set();
        throw keys.error;
    }
    if (!membership.data) return new Set();
    const held = new Set(
        ((keys.data ?? []) as { provider?: unknown }[]).map((row) =>
            String(row.provider),
        ),
    );
    return new Set(ROUTER_SLUGS.filter((slug) => held.has(slug)));
}

/** Every router's saved list for an organization, in one query. */
export async function getAllOrgRouterModels(
    orgId: string,
    db: Db = createServerSupabase(),
): Promise<RouterModelSelections> {
    const selections = Object.fromEntries(
        ROUTER_SLUGS.map((slug) => [slug, [] as string[]]),
    ) as RouterModelSelections;
    const { data, error } = await db
        .from("org_router_models")
        .select("router, model_id")
        .eq("org_id", orgId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
    if (error) {
        if (isMissingOrgRouterSchema(error)) return selections;
        throw error;
    }
    for (const row of (data ?? []) as { router?: unknown; model_id?: unknown }[]) {
        const router = ROUTER_SLUGS.find((slug) => slug === row.router);
        if (router && typeof row.model_id === "string" && row.model_id.trim())
            selections[router].push(row.model_id.trim());
    }
    return selections;
}

export async function getOrgRouterModels(
    orgId: string,
    router: RouterSlug,
    db: Db = createServerSupabase(),
): Promise<string[]> {
    return (await getAllOrgRouterModels(orgId, db))[router];
}

/**
 * The lists that govern `userId`'s work: their own for personal work, and
 * inside an organization the organization's for each router whose key it
 * holds, theirs for the rest. The model picker and the request both read
 * this, so what is offered is what will run.
 */
export async function getEffectiveRouterModels(
    userId: string,
    orgId: string | null | undefined,
    db: Db = createServerSupabase(),
): Promise<RouterModelSelections> {
    const own = await getAllUserRouterModels(userId, db);
    if (!orgId) return own;
    const held = await orgRouterKeyOwners(userId, orgId, db);
    if (held.size === 0) return own;
    const organization = await getAllOrgRouterModels(orgId, db);
    return Object.fromEntries(
        ROUTER_SLUGS.map((slug) => [
            slug,
            held.has(slug) ? organization[slug] : own[slug],
        ]),
    ) as RouterModelSelections;
}

export async function replaceOrgRouterModels(
    orgId: string,
    router: RouterSlug,
    modelIds: string[],
    db: Db = createServerSupabase(),
): Promise<void> {
    const { error } = await db.rpc("replace_org_router_models", {
        target_org_id: orgId,
        target_router: router,
        target_model_ids: modelIds,
    });
    if (error) throw error;
}

export async function replaceUserRouterModels(
    userId: string,
    router: string,
    modelIds: string[],
    db: Db = createServerSupabase(),
): Promise<void> {
    const { error } = await db.rpc("replace_user_router_models", {
        target_user_id: userId,
        target_router: router,
        target_model_ids: modelIds,
    });
    if (error) throw error;
}
