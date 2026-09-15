// chat settings — implementation behind the module facade.
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
import { getUserModelSettings, persistLastSelectedChatModel, persistLastSelectedReasoningLevel } from "../user/user.service";
import { resolveEffectiveChatModel, resolveEffectiveReasoningLevel } from "../../lib/modelSelection";

// PATCH /chat/:chatId — title and/or per-chat model + reasoning selection.
//
// The caller's role has already been checked by the route (title edits and
// model/reasoning changes are both content.edit). A model choice that
// resolves is also persisted as the user's last-selected chat model so their
// next new chat starts from it.
export async function updateChatSettings(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        /** The chat's currently stored model, for model resolution. */
        chatModel: string | null;
        title?: string;
        requestedModel?: string | null;
        reasoningLevel?: ReturnType<typeof resolveEffectiveReasoningLevel>;
    },
): Promise<
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; kind: "not_found" }
    | {
          ok: false;
          kind: "model";
          status: number;
          code: string;
          detail: string;
      }
    | { ok: false; kind: "error"; error: unknown }
> {
    const hasTitle = args.title !== undefined;
    const hasModel = "requestedModel" in args;

    const updates: Record<string, unknown> = {};
    if (hasTitle) updates.title = args.title;

    if (hasModel) {
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
        updates.model = resolution.model;
    }
    if (args.reasoningLevel) {
        updates.reasoning_level = args.reasoningLevel;
    }

    const { data, error } = await db
        .from("chats")
        .update(updates)
        .eq("id", args.chatId)
        .select("id, title, model, reasoning_level")
        .single();

    // Two different failures that must not share an answer. Authorization
    // already passed in the route, so a database error here is OUR fault, not
    // a statement about what exists: reporting it as "404 Chat not found"
    // tells the client a lie it will act on (dropping the chat from the
    // sidebar) and hides the outage from whoever is reading the logs. The row
    // being gone is the only real 404 — the chat was deleted between the
    // access check and the write. DELETE already splits them this way.
    if (error) return { ok: false, kind: "error", error };
    if (!data) return { ok: false, kind: "not_found" };

    if (typeof updates.model === "string") {
        const profileError = await persistLastSelectedChatModel(
            args.userId,
            updates.model,
            db,
        );
        if (profileError)
            return { ok: false, kind: "error", error: profileError };
    }
    if (args.reasoningLevel) {
        const profileError = await persistLastSelectedReasoningLevel(
            args.userId,
            args.reasoningLevel,
            db,
        );
        if (profileError)
            return { ok: false, kind: "error", error: profileError };
    }
    return { ok: true, data };
}
