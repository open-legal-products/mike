// Business logic + data-access for the project-chat module.
//
// Service layer behind projectChat.routes.ts. Takes an explicit Supabase client
// (`db`) plus request-derived primitives, does the pre-stream DB orchestration,
// and RETURNS the prepared data (or a typed error). It never touches req/res.
//
// IMPORTANT: the SSE streaming loop (header flush, runLLMStream, abort
// handling, assistant-message persistence) stays in the route — its ordering
// is delicate. Only the pre-stream preparation lives here.

import type { Db } from "../../lib/supabase";
import {
    buildProjectDocContext,
    buildMessages,
    buildUserPersonalisationPrompt,
    buildWorkflowStore,
    enrichWithPriorEvents,
    appendAskInputsResponseToAssistantMessage,
    generateSpotlightNonce,
    spotlightFilename,
    type AskInputsResponseRequest,
    type AssistantEvent,
    type ChatDocumentReference,
    type ChatMessage,
} from "../chat/chat.service";
import { getUserModelSettings, resolveUserChatSelection } from "../user/user.service";
import {
    checkProjectAccess,
    ensureChatAccess,
    projectHasSharedAudience,
    resolveContentOrgId,
} from "../../lib/access";
import { hasDirectContentGrants } from "../../lib/contentAccess";
import { can, type ProjectRole } from "../../lib/permissions";
import {
    resolveEffectiveReasoningLevel,
} from "../../lib/modelSelection";
import {
    beginMemoryConversationTurn,
    releaseMemoryConversationTurn,
    type MemoryConversationTurn,
} from "../../lib/memory/schedule";
// A project chat IS a `chats` row, so its title is persisted by the chat
// module. Crossing module boundaries is only allowed through the facade, so
// this reaches chat via `chat.service` and re-exports the function by name —
// the route imports everything it needs from its own service.
import { updateChatTitle, type ChatWriteResult } from "../chat/chat.service";

export { updateChatTitle };
export type { ChatWriteResult };

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
Copies created with replicate_document are saved as project documents in this project. After replication, use the returned doc_id for any requested edits.`;

// Persist the assistant's turn for a project chat.
//
// The streaming route reaches this from three places — the completed turn,
// the partial saved after a client abort, and the error turn — which all
// wrote the same row with the same "empty array means NULL" normalisation.
// That normalisation lives here so every caller stores an identical shape.
//
// Unlike the global /chat stream, this route does not pre-reserve an
// assistant message id, so the turn is a plain insert rather than an update.
// The id is still generated up front so the client can associate the streamed
// UI with the durable row, and `memory_input_message_id` links the turn back
// to the user message that opened it for the memory curator.
export async function insertAssistantMessage(
    db: Db,
    args: {
        chatId: string;
        assistantMessageId: string | null;
        events: AssistantEvent[];
        citations: unknown[];
        authorUserId: string;
        inputMessageId: string | null;
    },
): Promise<ChatWriteResult> {
    const { error } = await db.from("chat_messages").insert({
        id: args.assistantMessageId,
        chat_id: args.chatId,
        role: "assistant",
        content: args.events.length ? args.events : null,
        citations: args.citations.length ? args.citations : null,
        author_user_id: args.authorUserId,
        memory_input_message_id: args.inputMessageId,
    });

    if (error) return { ok: false, error };
    return { ok: true };
}

export type PreparedProjectChatStream = {
    chatId: string;
    chatTitle: string | null;
    lastUser: ChatMessage | undefined;
    // Whether the turn that is about to stream has a durable row behind it.
    // An ask_inputs continuation that could not be appended is not durable,
    // and must not trigger memory consolidation.
    completedTurnPersisted: boolean;
    // Whether the document-WRITING tools are offered this turn. This is a
    // question about the caller's standing on the PROJECT, never about their
    // standing in the thread — see the long note in prepareProjectChatStream.
    allowDocumentMutation: boolean;
    memorySharedAudience: boolean;
    memoryTurn: MemoryConversationTurn | null;
    docIndex: Awaited<ReturnType<typeof buildProjectDocContext>>["docIndex"];
    docStore: Awaited<ReturnType<typeof buildProjectDocContext>>["docStore"];
    apiMessages: ReturnType<typeof buildMessages>;
    workflowStore: Awaited<ReturnType<typeof buildWorkflowStore>>;
    legalResearchUs: boolean;
    apiKeys: Awaited<ReturnType<typeof getUserModelSettings>>["api_keys"];
    titleModel: Awaited<ReturnType<typeof getUserModelSettings>>["title_model"];
    selectedModel: string;
    selectedReasoningLevel: ReturnType<
        typeof resolveEffectiveReasoningLevel
    >;
    nonce: ReturnType<typeof generateSpotlightNonce>;
};

export async function prepareProjectChatStream(
    db: Db,
    args: {
        userId: string;
        userEmail: string | undefined;
        projectId: string;
        messages: ChatMessage[];
        chatId: string | null;
        // Pre-generated id for the user message this turn persists, so the
        // route can link the assistant row to it via memory_input_message_id.
        inputMessageId: string | null;
        displayed_doc: ChatDocumentReference | undefined;
        attached_documents: ChatDocumentReference[] | undefined;
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
    | { ok: true; prepared: PreparedProjectChatStream }
    | { ok: false; status: number; code?: string; detail: string }
    // "internal" carries the raw error so the route can hand it to
    // sendInternalError, preserving the request_id in the body and the
    // [http/internal-error] correlation log.
    | { ok: false; internal: true; error: unknown }
> {
    const {
        userId,
        userEmail,
        projectId,
        messages,
        displayed_doc,
        attached_documents,
    } = args;

    // Verify the caller can reach the project at all. Whether they may WRITE
    // is decided below, once we know whether this is their own chat.
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return { ok: false, status: 404, detail: "Project not found" };
    // Memory bookkeeping never decides whether the user gets an answer: a
    // database error in the audience check is reported as a normal internal
    // failure instead of escaping as a rejected promise.
    let memorySharedAudience = false;
    try {
        memorySharedAudience = await projectHasSharedAudience(
            db,
            projectId,
            projectAccess.project.org_id,
        );
    } catch (error) {
        return { ok: false, internal: true, error };
    }

    // Two different questions, deliberately answered by two different
    // derivations:
    //
    //   (1) May this caller CONTINUE THIS CONVERSATION? That is standing on
    //       the chat — `writeRole` below, from ensureChatAccess.
    //   (2) May this caller MODIFY THIS PROJECT'S DOCUMENTS? That is standing
    //       on the PROJECT, and nothing about a chat can grant it.
    //
    // They come apart exactly where chats gained grants of their own. A
    // project VIEWER holding a member grant on one chat may talk in that
    // thread, but the tool
    // loop runs against `buildProjectDocContext`, which loads EVERY document
    // in the project with no per-caller filter. Judging the tools on the
    // chat-derived role would hand that viewer edit_document, replicate_document
    // and the generate_* family over the whole project through a thread
    // someone shared with them.
    const allowDocumentMutation = can(projectAccess.projectRole, "content.edit");

    let chatId = args.chatId;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;

    // The role this write is judged against. Starting a NEW chat is judged
    // against the project — the caller is adding content to it. Continuing
    // an EXISTING one is judged against that chat, because a chat carries
    // standing of its own.
    let writeRole: ProjectRole | null = projectAccess.projectRole;

    if (chatId) {
        const { data: existing } = await db
            .from("chats")
            .select(
                "id, title, model, reasoning_level, project_id, user_id, org_id",
            )
            .eq("id", chatId)
            .maybeSingle();
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else {
            chatTitle = existing!.title;
            chatModel = (existing!.model as string | null) ?? null;
            chatReasoningLevel =
                (existing!.reasoning_level as string | null) ?? null;
            // Exactly the derivation GET /chat uses, so the two routes can
            // no longer disagree about who may write. It folds in the
            // branches the project role alone cannot see: the chat's own
            // creator, direct grants, and the chat's org — strongest-wins.
            //
            // A project VIEWER holding a member grant on the chat derives
            // `member` from ensureChatAccess and can open and read
            // the thread through GET /chat, while this route still saw only
            // their viewer role on the project and returned 403. The client
            // gates on the served role, so it rendered the message and then
            // lost it — nothing had been persisted.
            const chatAccess = await ensureChatAccess(
                existing as {
                    id: string;
                    user_id: string | null;
                    project_id: string | null;
                    org_id?: string | null;
                },
                userId,
                userEmail,
                db,
            );
            // No verdict at all means no write. `can(null, …)` is false, so
            // an unreadable chat cannot be written through this door either.
            writeRole = chatAccess.ok ? chatAccess.projectRole : null;
            try {
                memorySharedAudience =
                    memorySharedAudience ||
                    (await hasDirectContentGrants(db, "chat", existing!.id));
            } catch (error) {
                return { ok: false, internal: true, error };
            }
        }
    }

    // This verdict must precede model resolution: the model/reasoning
    // persistence below is a real UPDATE on the chats row, and running it
    // ahead of the gate would let a refused caller permanently change the
    // model on a thread they may not write to.
    if (!can(writeRole, "content.edit"))
        return {
            ok: false,
            status: 403,
            detail: "You do not have permission to write in this project.",
        };

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
        if (error) {
            return {
                ok: false,
                status: 500,
                detail: "Failed to save chat model",
            };
        }
    }

    if (!chatId) {
        const resolvedOrg = await resolveContentOrgId(db, { projectId });
        if (!resolvedOrg.ok) {
            return { ok: false, status: 500, detail: "Failed to create chat" };
        }
        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: projectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
                org_id: resolvedOrg.orgId,
            })
            .select("id, title")
            .single();
        if (error || !newChat)
            return { ok: false, status: 500, detail: "Failed to create chat" };
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

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
        // Fail open: the lease is only a checkpoint marker, and
        // beginMemoryConversationTurn now returns null instead of throwing
        // when the RPC fails, so this turn simply is not a checkpoint.
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
        const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
            projectId,
            userId,
            db,
            messages,
        );
        const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
            doc_id,
            filename: info.filename,
            folder_path: folderPaths.get(doc_id),
        }));
        const documentsById = new Map(
            Object.entries(docIndex).map(([slug, document]) => [
                document.document_id,
                { slug, filename: document.filename },
            ] as const),
        );
        // Generate the nonce before adding request metadata or prior events so
        // every document filename is fenced wherever it enters the prompt.
        const nonce = generateSpotlightNonce(chatId);
        const documentPromptRef = (
            documentId: string,
            requestFilename: string,
        ) => {
            const document = documentsById.get(documentId);
            return {
                slug: document?.slug,
                filename: spotlightFilename(
                    document?.filename ?? requestFilename,
                    nonce,
                ),
            };
        };

        const enrichedMessages = await enrichWithPriorEvents(
            messages,
            chatId,
            db,
            docIndex,
            nonce,
        );
        const messagesForLLM: ChatMessage[] = displayed_doc
            ? enrichedMessages.map((m, i) => {
                  if (i !== enrichedMessages.length - 1 || m.role !== "user")
                      return m;
                  const displayedDocument = documentPromptRef(
                      displayed_doc.document_id,
                      displayed_doc.filename,
                  );
                  return {
                      ...m,
                      content: `${m.content}\n\ndisplayed_doc: ${displayedDocument.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
                  };
              })
            : enrichedMessages;

        // The user-attached docs for this turn (dragged into / picked from
        // the chat input) come in as a request-level field. Surface them in
        // the system prompt with the current-turn doc_id slugs so the model
        // knows which docs the user is highlighting *now*, distinct from
        // the broader project doc list.
        let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
        if (attached_documents?.length) {
            const lines = attached_documents.map((d) => {
                const document = documentPromptRef(d.document_id, d.filename);
                return document.slug
                    ? `- ${document.slug}: ${document.filename}`
                    : `- ${document.filename}`;
            });
            systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
        }

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
        if (personalisationPrompt) {
            systemPromptExtra += `\n\n${personalisationPrompt}`;
        }
        const apiMessages = buildMessages(
            messagesForLLM,
            docAvailability,
            systemPromptExtra,
            undefined,
            legalResearchUs,
            nonce,
            "append",
            selectedModel,
        );

        const workflowStore = await buildWorkflowStore(userId, userEmail, db);

        return {
            ok: true,
            prepared: {
                chatId,
                chatTitle,
                lastUser,
                completedTurnPersisted,
                allowDocumentMutation,
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
                console.warn("[memory] project chat activity release failed", {
                    chatId,
                });
            }
        }
        throw error;
    }
}
