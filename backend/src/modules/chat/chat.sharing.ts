// chat sharing — implementation behind the module facade.
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
import { deleteContentGrant, listContentGrants, upsertContentGrant, type ContentAccessGrant } from "../../lib/contentAccess";
import { listContentPeople, type ResourcePeopleResult } from "../../lib/resourcePeople";
import { getAccessibleChat, type AccessibleChat } from "./chat.access";
import { normalizeEmail } from "../../lib/access";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { teamOrgIdOf } from "../../lib/personalOrgs";

// GET /chat/:chatId/people
export async function listChatPeople(
    db: Db,
    chat: AccessibleChat,
): Promise<ResourcePeopleResult> {
    return listContentPeople(db, "chat", chat);
}

// GET /chat/:chatId/access — role-aware direct grants.
export async function listChatGrants(
    db: Db,
    chatId: string,
): Promise<
    { ok: true; grants: ContentAccessGrant[] } | { ok: false; detail: string }
> {
    return listContentGrants(db, "chat", chatId);
}

// POST /chat/:chatId/access — grant or re-role one recipient.
export async function grantChatAccess(
    db: Db,
    args: {
        chatId: string;
        chat: AccessibleChat;
        userId: string;
        email: unknown;
        role: unknown;
    },
): Promise<
    | { ok: true; grant: ContentAccessGrant }
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "db_error"; detail: string }
> {
    // One creator's email, one row read. This used to scan every profile in
    // the deployment to build two maps and then use a single entry.
    const creatorProfile = args.chat.user_id
        ? await db
              .from("user_profiles")
              .select("email")
              .eq("user_id", args.chat.user_id)
              .maybeSingle()
        : null;
    // A failed read is not "the creator has no email". Swallowing the error
    // sent `creatorEmail: null` into upsertContentGrant, which is what stops
    // the creator being handed a guest grant on their own chat — so a
    // transient database fault quietly created exactly the row the check
    // exists to prevent.
    if (creatorProfile?.error)
        return {
            ok: false,
            kind: "db_error",
            detail: creatorProfile.error.message,
        };
    let orgId: string | null;
    try {
        orgId = await teamOrgIdOf(db, args.chat.org_id);
    } catch (error) {
        return {
            ok: false,
            kind: "db_error",
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to read the chat's organization",
        };
    }
    return upsertContentGrant(db, {
        kind: "chat",
        resourceId: args.chatId,
        email: args.email,
        role: args.role,
        createdBy: args.userId,
        orgId,
        creatorEmail:
            (creatorProfile?.data as { email?: string | null } | null)?.email ??
            null,
    });
}

// DELETE /chat/:chatId/access/:email — revoke one recipient.
export async function revokeChatAccess(
    db: Db,
    args: { chatId: string; email: string },
): Promise<{ ok: true; removed: boolean } | { ok: false; detail: string }> {
    return deleteContentGrant(db, {
        kind: "chat",
        resourceId: args.chatId,
        email: args.email,
    });
}

// Only a direct recipient can leave. Audited organization access and project
// membership are different access paths and must not offer this action.
type LeaveCandidate = {
    id: string;
    project_id?: string | null;
    access_role?: unknown;
};

export async function withChatLeaveAccess<T extends LeaveCandidate>(
    db: Db,
    chats: T[],
    userEmail: string | null | undefined,
): Promise<ServiceResult<(T & { can_leave: boolean })[]>> {
    const email = normalizeEmail(userEmail);
    const candidates = chats.filter((chat) =>
        chat.project_id === null &&
        (chat.access_role === "editor" || chat.access_role === "viewer"),
    );
    const leaveable = new Set<string>();
    if (email) {
        // Lists may be unpaginated; keep the PostgREST URL bounded.
        for (let offset = 0; offset < candidates.length; offset += 100) {
            const { data, error } = await db.from("chat_access_grants")
                .select("chat_id")
                .eq("email", email)
                .in("chat_id", candidates.slice(offset, offset + 100).map((chat) => chat.id))
                .in("role", ["editor", "viewer"]);
            if (error) return internalFailure(error);
            for (const row of data ?? []) leaveable.add(row.chat_id);
        }
    }
    return ok(chats.map((chat) => ({ ...chat, can_leave: leaveable.has(chat.id) })));
}

export async function leaveChat(
    db: Db,
    args: { chatId: string; userId: string; userEmail: string | null | undefined },
): Promise<ServiceResult<void>> {
    const access = await getAccessibleChat(db, args);
    if (!access.ok) return failure("not_found", "Chat not found");
    if (access.chat.project_id)
        return failure("conflict", "Leave the project to leave this chat.", "access_inherited");
    if (access.projectRole === "owner")
        return failure("forbidden", "Owners cannot leave their chat.");
    const email = normalizeEmail(args.userEmail);
    if (!email) return failure("forbidden", "This chat is not shared directly with you.");
    // Never accept a recipient from the request body. Recheck the grant's role
    // in the delete itself so a concurrent promotion cannot remove an owner.
    const { data, error } = await db.from("chat_access_grants")
        .delete()
        .eq("chat_id", args.chatId)
        .eq("email", email)
        .in("role", ["editor", "viewer"])
        .select("id");
    if (error) return internalFailure(error);
    if (!data?.length)
        return failure("forbidden", "This chat is not shared directly with you.");
    return ok(undefined);
}
