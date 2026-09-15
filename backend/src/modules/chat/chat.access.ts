// chat access — implementation behind the module facade.
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
import { checkProjectAccess, ensureChatAccess } from "../../lib/access";
import { can, type ProjectRole } from "../../lib/permissions";

export type AccessibleChat = {
    id: string;
    title: string | null;
    // Nullable since 20260902_01: content in an organization project outlives
    // the account that created it (the FK is ON DELETE SET NULL).
    user_id: string | null;
    project_id: string | null;
    model: string | null;
    reasoning_level: string | null;
    org_id?: string | null;
} & Record<string, unknown>;

export async function validateAccessibleProjectId(
    db: Db,
    args: {
        projectId: string | null;
        userId: string;
        userEmail: string | null | undefined;
    },
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
    if (!args.projectId) return { ok: true };
    // Creating a chat under a project contributes content to it: member+.
    const access = await checkProjectAccess(
        args.projectId,
        args.userId,
        args.userEmail,
        db,
    );
    if (!access.ok || !can(access.projectRole, "content.edit"))
        return { ok: false, status: 404, detail: "Project not found" };
    return { ok: true };
}

export type ChatAccess =
    | {
          ok: true;
          chat: AccessibleChat;
          /** Provenance only ("I started this thread"), not a right — the
           *  admin role the creator branch derives is what grants. */
          isCreator: boolean;
          projectRole: ProjectRole;
      }
    | { ok: false };

// Resolve a chat AND the caller's role for it, so callers can gate reads and
// writes separately: "can you see it" (project.view) and "can you write to
// it" (content.edit) are different questions. The role comes from
// `ensureChatAccess` (lib/access.ts) — the same derivation reviews use: the
// project chats inherit the project role exactly. Standalone chats use
// role-aware direct grants.
export async function getAccessibleChat(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        userEmail: string | null | undefined;
    },
): Promise<ChatAccess> {
    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", args.chatId)
        .maybeSingle();
    if (error || !chat) return { ok: false };

    const row = chat as AccessibleChat;
    const access = await ensureChatAccess(row, args.userId, args.userEmail, db);
    if (!access.ok) return { ok: false };
    return {
        ok: true,
        chat: row,
        isCreator: access.isCreator,
        projectRole: access.projectRole,
    };
}
