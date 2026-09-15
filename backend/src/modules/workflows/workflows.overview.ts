// "owned" and "shared" retain the list's original source semantics, while
// "private" and "collaborative" power the Access-column filter. The latter
// groups direct grants and organisation access together as collaborative.
export type WorkflowScope =
    | "all"
    | "owned"
    | "shared"
    | "private"
    | "collaborative";

export function parseWorkflowScope(value: unknown): WorkflowScope {
    if (
        value === "owned" ||
        value === "shared" ||
        value === "private" ||
        value === "collaborative"
    )
        return value;
    return "all";
}

export interface WorkflowsOverviewRpcArgs {
    p_user_id: string;
    p_user_email: string | null;
    p_type: string | null;
    p_scope: WorkflowScope;
    p_limit: number;
    p_offset: number;
    p_search_term: string | null;
    p_sort_key: string;
    p_sort_direction: string;
    p_practice: string | null;
    p_language: string | null;
    p_jurisdiction: string | null;
}

export function buildWorkflowsOverviewRpcArgs(params: {
    userId: string;
    userEmail: string | undefined;
    type?: string | null;
    scope?: WorkflowScope;
    pagination?: { limit: number; offset: number };
    searchTerm?: string | null;
    sort?: { key: string; direction: string };
    practice?: string | null;
    language?: string | null;
    jurisdiction?: string | null;
}): WorkflowsOverviewRpcArgs {
    return {
        p_user_id: params.userId,
        p_user_email: params.userEmail?.trim().toLowerCase() || null,
        p_type: params.type ?? null,
        p_scope: params.scope ?? "all",
        p_limit: params.pagination?.limit ?? 20,
        p_offset: params.pagination?.offset ?? 0,
        p_search_term: params.searchTerm ?? null,
        p_sort_key: params.sort?.key ?? "created",
        p_sort_direction: params.sort?.direction ?? "desc",
        p_practice: params.practice ?? null,
        p_language: params.language ?? null,
        p_jurisdiction: params.jurisdiction ?? null,
    };
}

export interface WorkflowIdsOverviewRpcArgs {
    p_user_id: string;
    p_user_email: string | null;
    p_type: string | null;
    p_scope: WorkflowScope;
    p_search_term: string | null;
    p_practice: string | null;
    p_language: string | null;
    p_jurisdiction: string | null;
    p_limit: number;
    p_offset: number;
}

// Lightweight sibling of buildWorkflowsOverviewRpcArgs for "select all
// matching" actions: no sort (order doesn't matter for a bulk id list), but
// still paginated — PostgREST enforces its own row cap on every RPC
// response, so a caller that skips pagination here will silently get a
// truncated id list back with no error.
export function buildWorkflowIdsOverviewRpcArgs(params: {
    userId: string;
    userEmail: string | undefined;
    type?: string | null;
    scope?: WorkflowScope;
    searchTerm?: string | null;
    practice?: string | null;
    language?: string | null;
    jurisdiction?: string | null;
    pagination: { limit: number; offset: number };
}): WorkflowIdsOverviewRpcArgs {
    return {
        p_user_id: params.userId,
        p_user_email: params.userEmail?.trim().toLowerCase() || null,
        p_type: params.type ?? null,
        p_scope: params.scope ?? "all",
        p_search_term: params.searchTerm ?? null,
        p_practice: params.practice ?? null,
        p_language: params.language ?? null,
        p_jurisdiction: params.jurisdiction ?? null,
        p_limit: params.pagination.limit,
        p_offset: params.pagination.offset,
    };
}
