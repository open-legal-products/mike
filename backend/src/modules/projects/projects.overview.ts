export type ProjectScope =
    | "all"
    | "mine"
    | "shared"
    | "collaborative"
    | "private";

export function parseProjectScope(value: unknown): ProjectScope {
    if (
        value === "mine" ||
        value === "shared" ||
        value === "collaborative" ||
        value === "private"
    )
        return value;
    return "all";
}

export interface ProjectsOverviewRpcArgs {
    p_user_id: string;
    p_user_email: string | null;
    p_scope: ProjectScope;
    p_limit: number;
    p_offset: number;
    p_search_term: string | null;
    p_sort_key: string;
    p_sort_direction: string;
    p_practice: string | null;
    p_owner_user_id: string | null;
}

export function buildProjectsOverviewRpcArgs(params: {
    userId: string;
    userEmail: string | undefined;
    scope?: ProjectScope;
    pagination?: { limit: number; offset: number };
    searchTerm?: string | null;
    sort?: { key: string; direction: string };
    practice?: string | null;
    ownerUserId?: string | null;
}): ProjectsOverviewRpcArgs {
    return {
        p_user_id: params.userId,
        p_user_email: params.userEmail?.trim().toLowerCase() || null,
        p_scope: params.scope ?? "all",
        p_limit: params.pagination?.limit ?? 20,
        p_offset: params.pagination?.offset ?? 0,
        p_search_term: params.searchTerm ?? null,
        p_sort_key: params.sort?.key ?? "created",
        p_sort_direction: params.sort?.direction ?? "desc",
        p_practice: params.practice ?? null,
        p_owner_user_id: params.ownerUserId ?? null,
    };
}

export interface ProjectIdsOverviewRpcArgs {
    p_user_id: string;
    p_user_email: string | null;
    p_scope: ProjectScope;
    p_search_term: string | null;
    p_practice: string | null;
    p_owner_user_id: string | null;
    p_limit: number;
    p_offset: number;
}

// Lightweight sibling of buildProjectsOverviewRpcArgs for "select all
// matching" actions: no sort (order doesn't matter for a bulk id list), but
// still paginated — PostgREST enforces its own row cap on every RPC
// response, so a caller that skips pagination here will silently get a
// truncated id list back with no error.
export function buildProjectIdsOverviewRpcArgs(params: {
    userId: string;
    userEmail: string | undefined;
    scope?: ProjectScope;
    searchTerm?: string | null;
    practice?: string | null;
    ownerUserId?: string | null;
    pagination: { limit: number; offset: number };
}): ProjectIdsOverviewRpcArgs {
    return {
        p_user_id: params.userId,
        p_user_email: params.userEmail?.trim().toLowerCase() || null,
        p_scope: params.scope ?? "all",
        p_search_term: params.searchTerm ?? null,
        p_practice: params.practice ?? null,
        p_owner_user_id: params.ownerUserId ?? null,
        p_limit: params.pagination.limit,
        p_offset: params.pagination.offset,
    };
}
