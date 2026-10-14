// The active workspace a list request is narrowed to.
//
// A person may belong to several organizations and also holds personal
// content (`org_id IS NULL`). List endpoints accept `?workspace=` to show one
// of those at a time:
//
//   absent      every workspace the caller can reach — callers that predate
//               workspaces, and pickers that are not scoped
//   "personal"  content with no organization
//   <org id>    that organization's content
//
// The value only ever NARROWS a list: the list RPCs still decide visibility
// with their access-role functions (see public.workspace_matches in
// schema.sql). Membership is checked here anyway, on every request, so that a
// person who has been removed from an organization is told their workspace is
// gone instead of being shown a list that is silently empty.

import { type Response } from "express";
import type { Db } from "./supabase";
import { isPersonalOrg } from "./personalOrgs";

export const PERSONAL_WORKSPACE = "personal";

/** `null` means "do not narrow". */
export type WorkspaceFilter = string | null;

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkspaceResolution =
    | { ok: true; workspace: WorkspaceFilter }
    | { ok: false; kind: "validation" | "not_found" };

/**
 * Resolve the raw `workspace` query value for this caller.
 *
 * A read failure throws rather than answering "not found": the client treats
 * a missing workspace as a reason to fall back to Personal, and a database
 * blip must not move somebody out of their firm's workspace.
 */
export async function resolveWorkspaceFilter(
    db: Db,
    userId: string,
    raw: unknown,
): Promise<WorkspaceResolution> {
    if (raw === undefined || raw === null || raw === "")
        return { ok: true, workspace: null };
    if (typeof raw !== "string") return { ok: false, kind: "validation" };
    if (raw === PERSONAL_WORKSPACE)
        return { ok: true, workspace: PERSONAL_WORKSPACE };
    if (!UUID_PATTERN.test(raw)) return { ok: false, kind: "validation" };

    const orgId = raw.toLowerCase();
    const [{ data, error }, personal] = await Promise.all([
        db
            .from("org_members")
            .select("org_id, organizations!inner(id)")
            .is("organizations.deleted_at", null)
            .eq("org_id", orgId)
            .eq("user_id", userId)
            .maybeSingle(),
        isPersonalOrg(db, orgId),
    ]);
    if (error) throw new Error("Failed to resolve the active workspace");
    // Not a member reads as missing, never forbidden: a 403 would confirm
    // that an organization with this id exists.
    if (!data) return { ok: false, kind: "not_found" };
    // A person's own organization is reached as "personal", never by id.
    if (personal) return { ok: false, kind: "not_found" };
    return { ok: true, workspace: orgId };
}

/**
 * `code` lets the client tell "this workspace is gone, fall back to
 * Personal" apart from every other 404 a list request can produce.
 */
export function sendWorkspaceFailure(
    res: Response,
    failure: Extract<WorkspaceResolution, { ok: false }>,
) {
    if (failure.kind === "validation")
        return void res.status(400).json({
            detail: "workspace must be 'personal' or an organization id",
        });
    return void res.status(404).json({
        detail: "Workspace not found",
        code: "workspace_not_found",
    });
}

/**
 * Whether a row filed under `orgId` is in `workspace`, for the lists that are
 * narrowed here rather than in SQL. public.workspace_matches is the SQL twin.
 */
export function workspaceMatches(
    workspace: WorkspaceFilter | undefined,
    orgId: string | null | undefined,
): boolean {
    if (!workspace) return true;
    if (workspace === PERSONAL_WORKSPACE) return !orgId;
    return orgId === workspace;
}

/**
 * The RPC argument for a resolved workspace. Omitted entirely when the list
 * is not narrowed, so a request that names no workspace calls the RPC exactly
 * as it did before the parameter existed.
 */
export function workspaceRpcArg(
    workspace: WorkspaceFilter | undefined,
): { p_workspace?: string } {
    return workspace ? { p_workspace: workspace } : {};
}
