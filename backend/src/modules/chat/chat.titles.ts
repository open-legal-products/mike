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
import { getUserModelSettings } from "../user/user.service";
import { generateAssistantChatTitle } from "./chat.title";
import { resolveEffectiveChatModel, titleModelForChat } from "../../lib/modelSelection";
import { ChatWriteResult } from "./chat.crud";

// Persist a chat's title.
//
// Shared by `generateChatTitle` and by the two title-persistence points in
// the POST /chat stream (the generated title, and the fallback that
// truncates the user's message). It only reports the error; the SSE loop in
// the route keeps deciding whether to rethrow or ignore it.
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

// POST /chat/:chatId/generate-title
export async function generateChatTitle(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        /** The chat's currently stored model, for model resolution. */
        chatModel: string | null;
        message: string;
        requestedModel: string | null;
    },
): Promise<
    | { ok: true; title: string }
    | {
          ok: false;
          kind: "model";
          status: number;
          code: string;
          detail: string;
      }
    | { ok: false; kind: "error" }
> {
    try {
        const settings = await getUserModelSettings(args.userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: args.requestedModel,
            chatModel: args.chatModel,
            lastSelectedModel: settings.last_selected_chat_model,
            apiKeys: settings.api_keys,
            userId: args.userId,
            db,
        });
        if (!resolution.ok) {
            return {
                ok: false,
                kind: "model",
                status: resolution.status,
                code: resolution.code,
                detail: resolution.detail,
            };
        }
        const title = await generateAssistantChatTitle({
            model: titleModelForChat(resolution.model, settings.title_model),
            message: args.message,
            apiKeys: settings.api_keys,
        });

        await updateChatTitle(db, { chatId: args.chatId, title });

        return { ok: true, title };
    } catch (err) {
        console.error("[generate-title]", err);
        return { ok: false, kind: "error" };
    }
}
