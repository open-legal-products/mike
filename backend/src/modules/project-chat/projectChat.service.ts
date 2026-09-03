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
    appendAskInputsResponseToLastAssistantMessage,
    generateSpotlightNonce,
    spotlightFilename,
    type AskInputsResponseRequest,
    type AssistantEvent,
    type ChatDocumentReference,
    type ChatMessage,
} from "../../lib/chat";
import {
    getUserModelSettings,
} from "../user/user.service";
import { checkProjectAccess } from "../../lib/access";
import {
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
} from "../../lib/modelSelection";
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
export async function insertAssistantMessage(
    db: Db,
    args: {
        chatId: string;
        events: AssistantEvent[];
        citations: unknown[];
    },
): Promise<ChatWriteResult> {
    const { error } = await db.from("chat_messages").insert({
        chat_id: args.chatId,
        role: "assistant",
        content: args.events.length ? args.events : null,
        citations: args.citations.length ? args.citations : null,
    });

    if (error) return { ok: false, error };
    return { ok: true };
}

export type PreparedProjectChatStream = {
    chatId: string;
    chatTitle: string | null;
    lastUser: ChatMessage | undefined;
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
> {
    const {
        userId,
        userEmail,
        projectId,
        messages,
        displayed_doc,
        attached_documents,
    } = args;

    // Verify the user has access to the project (owner or shared member).
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return { ok: false, status: 404, detail: "Project not found" };

    let chatId = args.chatId;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;

    if (chatId) {
        const { data: existing } = await db
            .from("chats")
            .select("id, title, model, reasoning_level, project_id")
            .eq("id", chatId)
            .single();
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else {
            chatTitle = existing!.title;
            chatModel = (existing!.model as string | null) ?? null;
            chatReasoningLevel =
                (existing!.reasoning_level as string | null) ?? null;
        }
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
        if (error) {
            return {
                ok: false,
                status: 500,
                detail: "Failed to save chat model",
            };
        }
    }

    if (!chatId) {
        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: projectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .select("id, title")
            .single();
        if (error || !newChat)
            return { ok: false, status: 500, detail: "Failed to create chat" };
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

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

    const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
        projectId,
        userId,
        db,
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
    const nonce = generateSpotlightNonce();
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
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    return {
        ok: true,
        prepared: {
            chatId,
            chatTitle,
            lastUser,
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
