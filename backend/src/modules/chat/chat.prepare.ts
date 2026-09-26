// chat prepare — implementation behind the module facade.
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
import { attachPriorReasoning, buildDocContext, buildMessages, buildUserPersonalisationPrompt, devLog, enrichWithPriorEvents, buildWorkflowStore, appendAskInputsResponseToAssistantMessage, generateSpotlightNonce, type AskInputsResponseRequest, type ChatMessage } from "./engine/index";
import { getUserModelSettings, resolveUserChatSelection } from "../user/user.service";
import { checkProjectAccess, projectHasSharedAudience, resolveContentOrgId } from "../../lib/access";
import { hasDirectContentGrants } from "../../lib/contentAccess";
import { can } from "../../lib/permissions";
import { resolveEffectiveReasoningLevel } from "../../lib/modelSelection";
import { replaysReasoning } from "../../lib/llm/registry";
import { beginMemoryConversationTurn, releaseMemoryConversationTurn, type MemoryConversationTurn } from "../../lib/memory/schedule";
import { getAccessibleChat, validateAccessibleProjectId } from "./chat.access";

// ---------------------------------------------------------------------------
// Pre-stream preparation for POST /chat (streaming)
// ---------------------------------------------------------------------------
//
// This performs the DB work that precedes the SSE stream: resolving or creating
// the chat, persisting the user message, opening the memory conversation turn,
// building doc context + messages, and assembling the workflow store. It
// RETURNS the prepared data; the route owns the header flush, runLLMStream
// loop, and persistence.

export type PreparedChatStream = {
    chatId: string;
    chatTitle: string | null;
    lastUser: ChatMessage | undefined;
    resolvedProjectId: string | null;
    // Whether the turn that is about to stream has a durable row behind it.
    // An ask_inputs continuation that could not be appended is not durable,
    // and must not trigger memory consolidation.
    completedTurnPersisted: boolean;
    // Whether the document-writing tools are offered this turn. A standalone
    // chat writes into the caller's own library, so it keeps them; a project
    // chat writes into the PROJECT, and that is a question about the caller's
    // project role, never about their standing in the thread. See the long
    // note in modules/project-chat/projectChat.service.ts — this is the same
    // partition on the route that serves standalone and project chats alike.
    allowDocumentMutation: boolean;
    canReadProjectMemory: boolean;
    canCurateProjectMemory: boolean;
    memorySharedAudience: boolean;
    memoryTurn: MemoryConversationTurn | null;
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
        // Pre-generated id for the user message this turn persists, so the
        // route can link the reserved assistant row back to it.
        inputMessageId: string | null;
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
    let canReadProjectMemory = false;
    let canCurateProjectMemory = false;
    let memorySharedAudience = false;
    // Whether the document-writing tools are offered this turn. A standalone
    // chat writes into the caller's own library, so it keeps them; a project
    // chat writes into the PROJECT, and that is a question about the caller's
    // project role, never about their standing in the thread. See the long
    // note in modules/project-chat/projectChat.service.ts — this is the same
    // partition on the route that serves standalone and project chats alike.
    let allowDocumentMutation = true;

    if (chatId) {
        const access = await getAccessibleChat(db, {
            chatId,
            userId,
            userEmail,
        });
        if (!access.ok)
            return { ok: false, status: 404, detail: "Chat not found" };
        // Appending messages (and triggering LLM generation) writes to the
        // chat: member+ only, mirroring the new-chat path below. Viewers
        // can read this chat (GET) but must not be able to write into it.
        if (!can(access.projectRole, "content.edit"))
            return {
                ok: false,
                status: 403,
                detail: "You do not have permission to modify this chat",
            };
        const existing = access.chat;

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
        // A database error in the audience check must not escape as a
        // rejected promise: memory bookkeeping never decides whether the
        // user gets an answer, and an unhandled rejection here used to
        // leave the request open with no response and no log.
        try {
            memorySharedAudience =
                !!existing.org_id ||
                existing.user_id !== userId ||
                (await hasDirectContentGrants(db, "chat", existing.id));
        } catch (error) {
            return { ok: false, internal: true, error };
        }
        chatTitle = existing.title;
        chatModel = existing.model;
        chatReasoningLevel = existing.reasoning_level;
        if (existingProjectId) {
            // The role above may have come from the chat's own share list;
            // creating documents in the project needs the project's verdict.
            const projectAccess = await checkProjectAccess(
                existingProjectId,
                userId,
                userEmail,
                db,
            );
            canReadProjectMemory = projectAccess.ok;
            canCurateProjectMemory =
                projectAccess.ok &&
                can(projectAccess.projectRole, "content.edit");
            allowDocumentMutation = canCurateProjectMemory;
            if (projectAccess.ok) {
                try {
                    memorySharedAudience =
                        memorySharedAudience ||
                        (await projectHasSharedAudience(
                            db,
                            existingProjectId,
                            projectAccess.project.org_id,
                        ));
                } catch (error) {
                    return { ok: false, internal: true, error };
                }
            }
        }
    }

    const selection = await resolveUserChatSelection(db, {
        userId,
        chatModel,
        chatReasoningLevel,
        requestedModel: args.requestedModel,
        requestedReasoning: args.requestedReasoning,
    });
    if (!selection.ok) return selection;
    const { modelSettings, selectedModel, selectedReasoningLevel } = selection;

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
        const projectAccess = await validateAccessibleProjectId(db, {
            projectId: resolvedProjectId,
            userId,
            userEmail,
        });
        if (!projectAccess.ok)
            return {
                ok: false,
                status: projectAccess.status,
                detail: projectAccess.detail,
            };
        canReadProjectMemory = resolvedProjectId !== null;
        canCurateProjectMemory = resolvedProjectId !== null;

        const resolvedOrg = await resolveContentOrgId(db, {
            projectId: resolvedProjectId,
        });
        if (!resolvedOrg.ok)
            return { ok: false, internal: true, error: resolvedOrg.detail };
        try {
            memorySharedAudience = resolvedProjectId
                ? await projectHasSharedAudience(
                      db,
                      resolvedProjectId,
                      resolvedOrg.orgId,
                  )
                : false;
        } catch (error) {
            return { ok: false, internal: true, error };
        }
        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: resolvedProjectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
                org_id: resolvedOrg.orgId,
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
    let completedTurnPersisted = true;
    let memoryTurn: MemoryConversationTurn | null = null;
    if (args.askInputsResponse) {
        const appendResult = await appendAskInputsResponseToAssistantMessage(
            db,
            chatId,
            args.askInputsResponse,
            userId,
        );
        if (appendResult === "forbidden") {
            return {
                ok: false,
                status: 403,
                detail:
                    "Only the user who started this turn can answer these questions",
            };
        }
        if (appendResult === "invalid") {
            return {
                ok: false,
                status: 400,
                detail: "The answers do not match the pending questions",
            };
        }
        if (appendResult === "stale") {
            return {
                ok: false,
                status: 409,
                code: "ask_inputs_stale",
                detail:
                    "These questions have already been answered or are no longer active",
            };
        }
        completedTurnPersisted = appendResult === "appended";
        if (!completedTurnPersisted) {
            return { ok: false, status: 500, detail: "Failed to save message" };
        }
    } else if (lastUser) {
        const { error: userMessageError } = await db
            .from("chat_messages")
            .insert({
                id: args.inputMessageId,
                chat_id: chatId,
                role: "user",
                content: lastUser.content,
                files: lastUser.files ?? null,
                workflow: lastUser.workflow ?? null,
                author_user_id: userId,
            });
        if (userMessageError) {
            return { ok: false, internal: true, error: userMessageError };
        }
    }

    if (args.askInputsResponse || lastUser) {
        // The lease is optional bookkeeping: it only stops an older curator
        // from committing mid-turn. beginMemoryConversationTurn now fails
        // open, so a lease failure skips this turn's checkpoint instead of
        // 500ing a request whose user message is already persisted.
        memoryTurn = await beginMemoryConversationTurn({
            db,
            surface: "chat",
            conversationId: chatId,
            actorUserId: userId,
        });
    }

    // From here on a throw (document context, workflow store) would strand
    // the conversation turn opened above: the route's finally block only runs
    // once this function has returned it. Release on the way out instead.
    try {
        const { docIndex, docStore } = await buildDocContext(
            messages,
            userId,
            db,
            chatId,
            "chat_messages",
            userEmail,
        );
        const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
            doc_id,
            filename: info.filename,
        }));
        // Generate the nonce before enriching prior events so document filenames
        // and workflow titles replayed from earlier turns are fenced as well.
        const nonce = generateSpotlightNonce(chatId);
        const historyMessages = replaysReasoning(selectedModel)
            ? await attachPriorReasoning(messages, chatId, selectedModel, db)
            : messages;
        const enrichedMessages = await enrichWithPriorEvents(
            historyMessages,
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
                completedTurnPersisted,
                allowDocumentMutation,
                canReadProjectMemory,
                canCurateProjectMemory,
                memorySharedAudience,
                memoryTurn,
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
    } catch (error) {
        if (memoryTurn) {
            try {
                await releaseMemoryConversationTurn({
                    db,
                    surface: "chat",
                    conversationId: chatId,
                    turn: memoryTurn,
                });
            } catch {
                console.warn("[memory] chat activity release failed", {
                    chatId,
                });
            }
        }
        throw error;
    }
}
