import { workspaceRpcArg, type WorkspaceFilter } from "../../lib/workspace";

export type TabularReviewScope = "all" | "in-project" | "standalone";

export function parseTabularReviewScope(value: unknown): TabularReviewScope {
    if (value === "in-project" || value === "standalone") return value;
    return "all";
}

// Sent only when filtering, so unfiltered calls keep their exact arguments.
function ownerRpcArg(ownerUserId: string | null | undefined) {
    return ownerUserId ? { p_owner_user_id: ownerUserId } : {};
}

export interface TabularReviewsOverviewRpcArgs {
    p_user_id: string;
    p_user_email: string | null;
    p_project_id: string | null;
    p_scope: TabularReviewScope;
    p_limit: number;
    p_offset: number;
    p_search_term: string | null;
    p_sort_key: string;
    p_sort_direction: string;
    p_workspace?: string;
    p_owner_user_id?: string;
}

export function buildTabularReviewsOverviewRpcArgs(params: {
    userId: string;
    userEmail: string | undefined;
    projectIdFilter: string | null;
    scope?: TabularReviewScope;
    pagination?: { limit: number; offset: number };
    searchTerm?: string | null;
    sort?: { key: string; direction: string };
    workspace?: WorkspaceFilter;
    ownerUserIdFilter?: string | null;
}): TabularReviewsOverviewRpcArgs {
    return {
        p_user_id: params.userId,
        p_user_email: params.userEmail?.trim().toLowerCase() || null,
        p_project_id: params.projectIdFilter,
        p_scope: params.scope ?? "all",
        p_limit: params.pagination?.limit ?? 20,
        p_offset: params.pagination?.offset ?? 0,
        p_search_term: params.searchTerm ?? null,
        p_sort_key: params.sort?.key ?? "created",
        p_sort_direction: params.sort?.direction ?? "desc",
        ...workspaceRpcArg(params.workspace),
        ...ownerRpcArg(params.ownerUserIdFilter),
    };
}

export interface TabularReviewIdsOverviewRpcArgs {
    p_user_id: string;
    p_user_email: string | null;
    p_project_id: string | null;
    p_scope: TabularReviewScope;
    p_search_term: string | null;
    p_limit: number;
    p_offset: number;
    p_workspace?: string;
    p_owner_user_id?: string;
}

// Lightweight sibling of buildTabularReviewsOverviewRpcArgs for "select all
// matching" actions: no sort (order doesn't matter for a bulk id list), but
// still paginated — PostgREST enforces its own row cap on every RPC
// response, so a caller that skips pagination here will silently get a
// truncated id list back with no error.
export function buildTabularReviewIdsOverviewRpcArgs(params: {
    userId: string;
    userEmail: string | undefined;
    projectIdFilter: string | null;
    scope?: TabularReviewScope;
    searchTerm?: string | null;
    workspace?: WorkspaceFilter;
    ownerUserIdFilter?: string | null;
    pagination: { limit: number; offset: number };
}): TabularReviewIdsOverviewRpcArgs {
    return {
        p_user_id: params.userId,
        p_user_email: params.userEmail?.trim().toLowerCase() || null,
        p_project_id: params.projectIdFilter,
        p_scope: params.scope ?? "all",
        p_search_term: params.searchTerm ?? null,
        p_limit: params.pagination.limit,
        p_offset: params.pagination.offset,
        ...workspaceRpcArg(params.workspace),
        ...ownerRpcArg(params.ownerUserIdFilter),
    };
}
