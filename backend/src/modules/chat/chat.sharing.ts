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
import { loadProfileUsersByEmail } from "../../lib/userLookup";
import { deleteContentGrant, listContentGrants, upsertContentGrant, type ContentAccessGrant } from "../../lib/contentAccess";
import { listContentPeople, type ResourcePeopleResult } from "../../lib/resourcePeople";
import { AccessibleChat } from "./chat.access";

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
    const { userById } = await loadProfileUsersByEmail(db);
    return upsertContentGrant(db, {
        kind: "chat",
        resourceId: args.chatId,
        email: args.email,
        role: args.role,
        createdBy: args.userId,
        creatorEmail: args.chat.user_id
            ? userById.get(args.chat.user_id)?.email
            : null,
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
