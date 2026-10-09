// chat titles — implementation behind the module facade.
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
import { ChatWriteResult } from "./chat.crud";

// Persist a chat's title.
//
// Used by the two title-persistence points in the POST /chat stream (the
// generated title, and the fallback that truncates the user's message). It
// only reports the error; the SSE loop in the route keeps deciding whether to
// rethrow or ignore it.
export async function updateChatTitle(
    db: Db,
    args: { chatId: string; title: string },
): Promise<ChatWriteResult> {
    const { error } = await db
        .from("chats")
        .update({ title: args.title })
        .eq("id", args.chatId);

    if (error) return { ok: false, error };
    return { ok: true };
}
