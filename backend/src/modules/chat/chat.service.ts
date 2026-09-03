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

import type { Db } from "../../lib/supabase";
import {
    buildDocContext,
    buildMessages,
    buildUserPersonalisationPrompt,
    devLog,
    enrichWithPriorEvents,
    buildWorkflowStore,
    appendAskInputsResponseToLastAssistantMessage,
    generateSpotlightNonce,
    withoutEmptyAssistantReservations,
    type AskInputsResponseRequest,
    type ChatMessage,
} from "../../lib/chat";
import {
    getUserModelSettings,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
} from "../user/user.service";
import { checkProjectAccess } from "../../lib/access";
import { generateAssistantChatTitle } from "./chat.title";
import {
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../../lib/modelSelection";

// One devLog for the whole tree lives in lib/chat; re-exported so the route
// file keeps importing it from the service alongside everything else.
export { devLog };
// Title generation is chat-domain logic (modules/chat/chat.title.ts);
// project-chat reaches it through this facade.
export { generateAssistantChatTitle };

type AccessibleChat = {
    id: string;
    title: string | null;
    user_id: string;
    project_id: string | null;
    model: string | null;
    reasoning_level: string | null;
} & Record<string, unknown>;

async function validateAccessibleProjectId(
    projectId: string | null,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
    if (!projectId) return { ok: true };
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
        return { ok: false, status: 404, detail: "Project not found" };
    return { ok: true };
}

async function getAccessibleChat(
    chatId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<AccessibleChat | null> {
    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .maybeSingle();
    if (error || !chat) return null;

    const row = chat as AccessibleChat;
    if (row.user_id === userId) return row;

    if (row.project_id) {
        const access = await checkProjectAccess(
            row.project_id,
            userId,
            userEmail,
            db,
        );
        if (access.ok) return row;
    }

    return null;
}

// Stored doc_edited events capture the `status` at the time the assistant
// produced the edit (always "pending"). If the user later accepts or rejects,
// `document_edits.status` is updated but the stored event is not. On chat load
// we merge the current DB status in so EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: Db,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string")
                versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// ---------------------------------------------------------------------------
// Non-streaming endpoints
// ---------------------------------------------------------------------------

// GET /chat
export async function listChats(
    db: Db,
    args: { userId: string; limit: number | null; offset: number },
): Promise<{ ok: true; data: unknown[] } | { ok: false; error: unknown }> {
    const { data, error } = await db.rpc("get_chats_overview", {
        p_user_id: args.userId,
        p_limit: args.limit,
        p_offset: args.offset,
    });
    if (error) return { ok: false, error };
    return { ok: true, data: data ?? [] };
}

// POST /chat/create
export async function createChat(
    db: Db,
    args: {
        userId: string;
        userEmail: string | undefined;
        projectId: string | null;
    },
): Promise<
    | { ok: true; id: string }
    | { ok: false; kind: "access"; status: number; detail: string }
    | { ok: false; kind: "error"; error: unknown }
> {
    const projectAccess = await validateAccessibleProjectId(
        args.projectId,
        args.userId,
        args.userEmail,
        db,
    );
    if (!projectAccess.ok)
        return {
            ok: false,
            kind: "access",
            status: projectAccess.status,
            detail: projectAccess.detail,
        };

    const { data, error } = await db
        .from("chats")
        .insert({ user_id: args.userId, project_id: args.projectId ?? null })
        .select("id")
        .single();

    if (error) return { ok: false, kind: "error", error };
    return { ok: true, id: data.id };
}

// GET /chat/:chatId
export async function getChatWithMessages(
    db: Db,
    args: { chatId: string; userId: string; userEmail: string | undefined },
): Promise<
    | { ok: true; chat: AccessibleChat; messages: Record<string, unknown>[] }
    | { ok: false }
> {
    const chat = await getAccessibleChat(
        args.chatId,
        args.userId,
        args.userEmail,
        db,
    );
    if (!chat) return { ok: false };

    const { data: messages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", args.chatId)
        .order("created_at", { ascending: true });

    const hydrated = await hydrateEditStatuses(
        withoutEmptyAssistantReservations(messages ?? []),
        db,
    );
    return { ok: true, chat, messages: hydrated };
}

// PATCH /chat/:chatId — title and/or per-chat model + reasoning selection.
//
// A title change requires ownership; a model/reasoning change only requires
// access (project collaborators steer the model of a shared chat they can
// use). A model choice that resolves is also persisted as the user's
// last-selected chat model so their next new chat starts from it.
export async function updateChatSettings(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        userEmail: string | undefined;
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

    const chat = await getAccessibleChat(
        args.chatId,
        args.userId,
        args.userEmail,
        db,
    );
    if (!chat || (hasTitle && chat.user_id !== args.userId)) {
        return { ok: false, kind: "not_found" };
    }

    let selectedModel: string | undefined;
    const selectedReasoningLevel = args.reasoningLevel;
    if (hasModel) {
        const settings = await getUserModelSettings(args.userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: args.requestedModel,
            chatModel: chat.model,
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
        selectedModel = resolution.model;
    }

    const update = {
        ...(hasTitle ? { title: args.title } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedReasoningLevel
            ? { reasoning_level: selectedReasoningLevel }
            : {}),
    };
    const { data, error } = await db
        .from("chats")
        .update(update)
        .eq("id", args.chatId)
        .select("id, title, model, reasoning_level")
        .single();

    if (error || !data) return { ok: false, kind: "not_found" };

    if (selectedModel) {
        const profileError = await persistLastSelectedChatModel(
            args.userId,
            selectedModel,
            db,
        );
        if (profileError)
            return { ok: false, kind: "error", error: profileError };
    }
    if (selectedReasoningLevel) {
        const profileError = await persistLastSelectedReasoningLevel(
            args.userId,
            selectedReasoningLevel,
            db,
        );
        if (profileError)
            return { ok: false, kind: "error", error: profileError };
    }
    return { ok: true, data };
}

// DELETE /chat/:chatId
export async function deleteChat(
    db: Db,
    args: { chatId: string; userId: string },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const { error } = await db
        .from("chats")
        .delete()
        .eq("id", args.chatId)
        .eq("user_id", args.userId);

    if (error) return { ok: false, error };
    return { ok: true };
}

// Result of a write whose failure the caller decides how to treat: the
// streaming route rethrows it from inside the title promise (so the
// surrounding `.catch` logs it) but ignores it for the truncated-content
// fallback, which must never break a stream that already succeeded.
export type ChatWriteResult = { ok: true } | { ok: false; error: unknown };

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
        userEmail: string | undefined;
        message: string;
        requestedModel: string | null;
    },
): Promise<
    | { ok: true; title: string }
    | { ok: false; kind: "not_found" }
    | {
          ok: false;
          kind: "model";
          status: number;
          code: string;
          detail: string;
      }
    | { ok: false; kind: "error" }
> {
    const chat = await getAccessibleChat(
        args.chatId,
        args.userId,
        args.userEmail,
        db,
    );
    if (!chat) return { ok: false, kind: "not_found" };

    try {
        const settings = await getUserModelSettings(args.userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: args.requestedModel,
            chatModel: chat.model,
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

// ---------------------------------------------------------------------------
// Pre-stream preparation for POST /chat (streaming)
// ---------------------------------------------------------------------------
//
// This performs the DB work that precedes the SSE stream: resolving or creating
// the chat, persisting the user message, building doc context + messages, and
// assembling the workflow store. It RETURNS the prepared data; the route owns
// the header flush, runLLMStream loop, and persistence.

export type PreparedChatStream = {
    chatId: string;
    chatTitle: string | null;
    lastUser: ChatMessage | undefined;
    resolvedProjectId: string | null;
    docIndex: Awaited<ReturnType<typeof buildDocContext>>["docIndex"];
    docStore: Awaited<ReturnType<typeof buildDocContext>>["docStore"];
    apiMessages: ReturnType<typeof buildMessages>;
    workflowStore: Awaited<ReturnType<typeof buildWorkflowStore>>;
    legalResearchUs: boolean;
    apiKeys: Awaited<ReturnType<typeof getUserModelSettings>>["api_keys"];
    titleModel: Awaited<
        ReturnType<typeof getUserModelSettings>
    >["title_model"];
    selectedModel: string;
    selectedReasoningLevel: ReturnType<
        typeof resolveEffectiveReasoningLevel
    >;
    nonce: ReturnType<typeof generateSpotlightNonce>;
};

export async function prepareChatStream(
    db: Db,
    args: {
        userId: string;
        userEmail: string | undefined;
        messages: ChatMessage[];
        chatId: string | null;
        projectIdProvided: boolean;
        projectId: string | null;
        // Parsed `ask_inputs_response` payload (answers to an ask_inputs
        // event emitted by the assistant in a prior turn). When present, the
        // user's answers are appended onto the previous assistant message
        // instead of being stored as a new user message.
        askInputsResponse: AskInputsResponseRequest | null;
        requestedModel: string | null | undefined;
        requestedReasoning:
            | ReturnType<typeof resolveEffectiveReasoningLevel>
            | undefined;
    },
): Promise<
    | { ok: true; prepared: PreparedChatStream }
    | { ok: false; status: number; code?: string; detail: string }
    // "internal" carries the raw error so the route can hand it to
    // sendInternalError, preserving the request_id in the body and the
    // [http/internal-error] correlation log.
    | { ok: false; internal: true; error: unknown }
> {
    const { userId, userEmail, messages } = args;
    let chatId = args.chatId;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;
    let resolvedProjectId: string | null = args.projectId;

    if (chatId) {
        const existing = await getAccessibleChat(chatId, userId, userEmail, db);
        if (!existing)
            return { ok: false, status: 404, detail: "Chat not found" };

        const existingProjectId = existing.project_id ?? null;
        if (
            args.projectIdProvided &&
            args.projectId !== existingProjectId
        ) {
            return {
                ok: false,
                status: 400,
                detail: "project_id does not match chat",
            };
        }
        resolvedProjectId = existingProjectId;
        chatTitle = existing.title;
        chatModel = existing.model;
        chatReasoningLevel = existing.reasoning_level;
    }

    const modelSettings = await getUserModelSettings(userId, db);
    const modelResolution = await resolveEffectiveChatModel({
        requested: args.requestedModel,
        chatModel,
        lastSelectedModel: modelSettings.last_selected_chat_model,
        apiKeys: modelSettings.api_keys,
        userId,
        db,
    });
    if (!modelResolution.ok) {
        return {
            ok: false,
            status: modelResolution.status,
            code: modelResolution.code,
            detail: modelResolution.detail,
        };
    }
    const selectedModel = modelResolution.model;
    const selectedReasoningLevel = resolveEffectiveReasoningLevel({
        model: selectedModel,
        requested: args.requestedReasoning,
        chatReasoningLevel,
        lastSelectedReasoningLevel:
            modelSettings.last_selected_reasoning_level,
    });

    if (
        chatId &&
        (chatModel !== selectedModel ||
            chatReasoningLevel !== selectedReasoningLevel)
    ) {
        const { error } = await db
            .from("chats")
            .update({
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .eq("id", chatId);
        if (error) return { ok: false, internal: true, error };
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        const projectAccess = await validateAccessibleProjectId(
            resolvedProjectId,
            userId,
            userEmail,
            db,
        );
        if (!projectAccess.ok)
            return {
                ok: false,
                status: projectAccess.status,
                detail: projectAccess.detail,
            };

        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: resolvedProjectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return { ok: false, status: 500, detail: "Failed to create chat" };
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    if (!chatId) {
        return {
            ok: false,
            status: 500,
            detail: "Failed to initialize chat",
        };
    }

    devLog("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (args.askInputsResponse) {
        await appendAskInputsResponseToLastAssistantMessage(
            db,
            chatId,
            args.askInputsResponse,
        );
    } else if (lastUser) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
        });
    }

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        db,
        chatId,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    // Generate the nonce before enriching prior events so document filenames
    // and workflow titles replayed from earlier turns are fenced as well.
    const nonce = generateSpotlightNonce();
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
        nonce,
    );
    const {
        api_keys: apiKeys,
        legal_research_us: legalResearchUs,
        title_model: titleModel,
        personalisation,
    } = modelSettings;
    const personalisationPrompt = buildUserPersonalisationPrompt(
        personalisation,
        nonce,
    );
    const apiMessages = buildMessages(
        enrichedMessages,
        docAvailability,
        personalisationPrompt || undefined,
        undefined,
        legalResearchUs,
        nonce,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    return {
        ok: true,
        prepared: {
            chatId,
            chatTitle,
            lastUser,
            resolvedProjectId,
            docIndex,
            docStore,
            apiMessages,
            workflowStore,
            legalResearchUs,
            apiKeys,
            titleModel,
            selectedModel,
            selectedReasoningLevel,
            nonce,
        },
    };
}
