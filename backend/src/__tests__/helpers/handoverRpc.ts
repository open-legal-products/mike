// The database's member hand-over functions (org_member_sole_owned_items,
// org_member_private_standalone, assign_org_member_items), for tests whose
// Supabase stand-in is a map of tables.
//
// Public items with no remaining explicit owner are transferred. Unshared
// items with no remaining owner are archived; their titles are never returned.

type Row = Record<string, unknown>;
type Tables = Record<string, Row[] | undefined>;

const OWNED = {
    project: {
        table: "projects",
        overrides: "project_org_access_overrides",
        key: "project_id",
        title: "name",
    },
    workflow: {
        table: "workflows",
        overrides: "workflow_org_access_overrides",
        key: "workflow_id",
        title: "title",
    },
} as const;

const STANDALONE = {
    chat: { table: "chats", grants: "chat_access_grants", key: "chat_id" },
    tabular_review: {
        table: "tabular_reviews",
        grants: "tabular_review_access_grants",
        key: "tabular_review_id",
    },
} as const;

const isMember = (tables: Tables, orgId: unknown, userId: unknown) =>
    (tables.org_members ?? []).some(
        (member) => member.org_id === orgId && member.user_id === userId,
    );

function departureItems(tables: Tables, orgId: unknown, userIds: unknown[]) {
    const leaving = (id: unknown) => userIds.includes(id);
    const remaining = (id: unknown) => !leaving(id) && isMember(tables, orgId, id);
    const projects = (Object.keys(OWNED) as (keyof typeof OWNED)[]).flatMap((kind) => {
        const config = OWNED[kind];
        const overrides = tables[config.overrides] ?? [];
        const hasOwner = (item: Row, matches: (id: unknown) => boolean) =>
            overrides.some((grant) => grant[config.key] === item.id &&
                grant.role === "owner" && matches(grant.user_id));
        return (tables[config.table] ?? [])
            .filter((item) => item.org_id === orgId &&
                (leaving(item.user_id) || hasOwner(item, leaving)) &&
                !remaining(item.user_id) && !hasOwner(item, remaining))
            .map((item) => ({
                kind, item_id: item.id,
                title: item.visibility === "organization" ? item[config.title] ?? null : null,
                disposition: item.visibility === "organization" || overrides.some((grant) => grant[config.key] === item.id && ["owner", "editor", "viewer"].includes(String(grant.role)) && remaining(grant.user_id)) ? "transfer" : "archive",
            }));
    });
    const profiles = new Map((tables.user_profiles ?? []).map((profile) => [
        String(profile.email ?? "").toLowerCase(), profile.user_id,
    ]));
    const standalone = (Object.keys(STANDALONE) as (keyof typeof STANDALONE)[]).flatMap((kind) => {
        const config = STANDALONE[kind];
        const hasOwner = (item: Row, matches: (id: unknown) => boolean) =>
            (tables[config.grants] ?? []).some((grant) =>
                grant[config.key] === item.id && grant.role === "owner" &&
                matches(profiles.get(String(grant.email))));
        return (tables[config.table] ?? [])
            .filter((item) => item.org_id === orgId && !item.project_id &&
                (leaving(item.user_id) || hasOwner(item, leaving)) &&
                !remaining(item.user_id) && !hasOwner(item, remaining))
            .map((item) => ({ kind, item_id: item.id, title: null, disposition: "archive" }));
    });
    const documents = (tables.documents ?? [])
        .filter((item) => item.org_id === orgId && !item.project_id &&
            !item.workflow_id && leaving(item.user_id))
        .map((item) => ({ kind: "document", item_id: item.id, title: null, disposition: "archive" }));
    return [...projects, ...standalone, ...documents];
}

function soleOwnedItems(tables: Tables, orgId: unknown, userId: unknown) {
    return departureItems(tables, orgId, [userId])
        .filter((item) => item.disposition === "transfer")
        .map((item) => ({ kind: item.kind as keyof typeof OWNED, item_id: item.item_id, title: item.title }));
}

/**
 * The answer to one of the hand-over RPCs, or `undefined` for any other
 * function so the caller's own `rpc` stub can handle it.
 */
export function handoverRpcResult(
    tables: Tables,
    name: string,
    args: Record<string, unknown> | undefined,
):
    | { data: unknown; error: null }
    | { data: null; error: { code: string; message: string } }
    | undefined {
    const orgId = args?.p_org_id;
    if (name === "remove_org_member") {
        const from = args?.p_user_id;
        const to = args?.p_successor_id ?? (tables.org_members ?? []).find((m) => m.org_id === orgId && m.role === "owner" && m.user_id !== from)?.user_id;
        const items = departureItems(tables, orgId, [from]);
        handoverRpcResult(tables, "assign_org_member_items", { p_org_id: orgId, p_from_user_id: from, p_to_user_id: to, p_assigned_by: args?.p_actor_id });
        for (const item of items.filter((item) => item.disposition === "archive")) {
            const table = item.kind === "project" ? "projects" : item.kind === "workflow" ? "workflows" : item.kind === "chat" ? "chats" : item.kind === "tabular_review" ? "tabular_reviews" : "documents";
            const row = (tables[table] ?? []).find((row) => row.id === item.item_id);
            if (row) row.archived_at = new Date().toISOString();
        }
        for (const table of ["projects", "workflows", "chats", "tabular_reviews", "documents"]) {
            for (const row of tables[table] ?? []) if (row.org_id === orgId && row.user_id === from) row.user_id = null;
        }
        tables.org_members = (tables.org_members ?? []).filter((m) => m.org_id !== orgId || m.user_id !== from);
        return { data: null, error: null };
    }
    if (name === "org_member_sole_owned_items")
        return { data: soleOwnedItems(tables, orgId, args?.p_user_id), error: null };
    if (name === "org_members_departure_items")
        return { data: departureItems(tables, orgId, args?.p_user_ids as unknown[]), error: null };
    if (name === "org_member_private_standalone")
        return {
            data: departureItems(tables, orgId, [args?.p_user_id])
                .filter((item) => ["chat", "tabular_review", "document"].includes(item.kind))
                .map((item) => ({ kind: item.kind, item_id: item.item_id })),
            error: null,
        };
    if (name === "assign_org_member_items") {
        const from = args?.p_from_user_id;
        const to = args?.p_to_user_id;
        if (!to || to === from || !isMember(tables, orgId, to))
            return {
                data: null,
                error: {
                    code: "23514",
                    message:
                        "Work is handed to another member of the organization",
                },
            };
        const items = soleOwnedItems(tables, orgId, from);
        if ((tables.org_members ?? []).some((member) =>
            member.org_id === orgId && member.user_id === to && member.role === "owner"))
            return { data: items.length, error: null };
        for (const item of items) {
            const config = OWNED[item.kind];
            const overrides = (tables[config.overrides] ??= []);
            const existing = overrides.find(
                (override) =>
                    override[config.key] === item.item_id &&
                    override.user_id === to,
            );
            if (existing) existing.role = "owner";
            else
                overrides.push({
                    [config.key]: item.item_id,
                    org_id: orgId,
                    user_id: to,
                    role: "owner",
                    assigned_by: args?.p_assigned_by ?? null,
                });
        }
        return { data: items.length, error: null };
    }
    return undefined;
}
