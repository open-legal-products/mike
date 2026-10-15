// chat crud — implementation behind the module facade.
// Business logic + data-access for the chat module.
//
// These functions are the service layer behind chat.routes.ts. They take an
// explicit Supabase client (`db`) plus request-derived primitives, perform the
// chat orchestration / DB work, and RETURN values or typed error results. They
// never touch req/res — the thin route handlers map the results onto HTTP
// status codes, headers, and response bodies.
//
// IMPORTANT: the SSE streaming loop (header flush, runLLMStream, abort
// handling, assistant-message persistence) deliberately stays in the route —
// its ordering is delicate. Only the NON-streaming logic and the pre-stream
// DB preparation live here. `prepareChatStream` returns the prepared data the
// route needs to run the stream; it does not stream.
import { type Db } from "../../lib/supabase";
import { resolveContentOrgId, resolveStandaloneOrgId } from "../../lib/access";
import { workspaceRpcArg, type WorkspaceFilter } from "../../lib/workspace";
import { validateAccessibleProjectId } from "./chat.access";
import { withChatLeaveAccess } from "./chat.sharing";

// ---------------------------------------------------------------------------
// Non-streaming endpoints
// ---------------------------------------------------------------------------

// GET /chat
// Lists every chat the caller could open: the RPC's predicate mirrors
// ensureChatAccess branch for branch (creator, direct grant, accessible
// project), so the list and GET /chat/:chatId can never disagree
// about what exists. Each row carries is_owner so the sidebar can tell the
// caller's own chats from colleagues' ones — provenance, not a role.
export async function listChats(
    db: Db,
    args: {
        userId: string;
        userEmail: string | undefined;
        limit: number | null;
        offset: number;
        beforeUpdatedAt: string | null;
        beforeId: string | null;
        workspace?: WorkspaceFilter;
    },
): Promise<{ ok: true; data: unknown[] } | { ok: false; error: unknown }> {
    const { data, error } = await db.rpc("get_chats_overview", {
        p_user_id: args.userId,
        p_user_email: args.userEmail?.trim().toLowerCase() ?? null,
        p_limit: args.limit,
        p_offset: args.offset,
        p_before_updated_at: args.beforeUpdatedAt,
        p_before_id: args.beforeId,
        ...workspaceRpcArg(args.workspace),
    });
    if (error) return { ok: false, error };
    const result = await withChatLeaveAccess(db, data ?? [], args.userEmail);
    if (!result.ok)
        return { ok: false, error: result.kind === "error" ? result.error : result.detail };
    return { ok: true, data: result.data };
}

// POST /chat/create
export async function createChat(
    db: Db,
    args: {
        userId: string;
        userEmail: string | undefined;
        projectId: string | null;
        /** The organization whose workspace a standalone chat is started in. */
        orgId?: unknown;
    },
): Promise<
    | { ok: true; id: string }
    | { ok: false; kind: "access"; status: number; detail: string }
    | { ok: false; kind: "error"; error: unknown }
> {
    const projectAccess = await validateAccessibleProjectId(db, {
        projectId: args.projectId,
        userId: args.userId,
        userEmail: args.userEmail,
    });
    if (!projectAccess.ok)
        return {
            ok: false,
            kind: "access",
            status: projectAccess.status,
            detail: projectAccess.detail,
        };

    // Tenant stamping, like every other content create: a project chat
    // inherits the project's org. A standalone chat belongs to the workspace
    // it is started in — the organization the client names, or Personal
    // (org_id null) — and stays private until it receives a direct grant.
    let resolvedOrg: { ok: true; orgId: string | null };
    if (args.projectId) {
        const projectOrg = await resolveContentOrgId(db, {
            projectId: args.projectId,
        });
        if (!projectOrg.ok)
            return { ok: false, kind: "error", error: projectOrg.detail };
        resolvedOrg = projectOrg;
    } else {
        const standalone = await resolveStandaloneOrgId(db, {
            userId: args.userId,
            orgId: args.orgId,
        });
        if (!standalone.ok)
            return {
                ok: false,
                kind: "access",
                status: 400,
                detail: standalone.detail,
            };
        resolvedOrg = standalone;
    }
    const { data, error } = await db
        .from("chats")
        .insert({
            user_id: args.userId,
            project_id: args.projectId ?? null,
            org_id: resolvedOrg.orgId,
        })
        .select("id")
        .single();

    if (error) return { ok: false, kind: "error", error };
    return { ok: true, id: data.id };
}

// DELETE /chat/:chatId
export async function deleteChat(
    db: Db,
    args: { chatId: string },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const { error } = await db.from("chats").delete().eq("id", args.chatId);

    if (error) return { ok: false, error };
    return { ok: true };
}

// Result of a write whose failure the caller decides how to treat: the
// streaming route rethrows it from inside the title promise (so the
// surrounding `.catch` logs it) but ignores it for the truncated-content
// fallback, which must never break a stream that already succeeded.
export type ChatWriteResult = { ok: true } | { ok: false; error: unknown };
