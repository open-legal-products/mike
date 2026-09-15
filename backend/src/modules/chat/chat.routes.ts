import { openAssistantSse } from "../../lib/assistantSse";
// HTTP layer for the chat module.
//
// Route handlers parse params/query/body, call the chat.service functions,
// and map their typed results onto status codes and JSON. The SSE streaming
// loop for POST /chat (header flush, runLLMStream, abort handling,
// assistant-message persistence) stays here — its ordering is delicate; the
// pre-stream preparation lives in chat.service.ts.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { enqueueChatTurnAudit } from "../../lib/audit";
import {
    appendAssistantEventsToMessage,
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    extractCitations,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalChatId,
    parseOptionalModel,
    parseOptionalReasoning,
    parseOptionalProjectId,
    createReservedAssistantMessageUpdater,

    reserveAssistantMessage,
} from "./engine/index";
import { normalizeEmail } from "../../lib/access";
import { can } from "../../lib/permissions";
import { generateAssistantChatTitle } from "./chat.title";
import { sendInternalError } from "../../lib/httpError";
import { titleModelForChat } from "../../lib/modelSelection";
import {
    releaseMemoryConversationTurn,
    scheduleMemoryConsolidation,
} from "../../lib/memory/schedule";
import {
    createChat,
    deleteChat,
    devLog,
    generateChatTitle,
    getAccessibleChat,
    getChatMessages,
    grantChatAccess,
    listChatGrants,
    listChatPeople,
    listChats,
    prepareChatStream,
    revokeChatAccess,
    updateChatSettings,
    updateChatTitle,
} from "./chat.service";

export const chatRouter = Router();

// GET /chat
// Lists every chat the caller could open: the RPC's predicate mirrors
// ensureChatAccess branch for branch (creator, direct grant, accessible
// project), so the list and GET /chat/:chatId can never disagree
// about what exists. Each row carries is_owner so the sidebar can tell the
// caller's own chats from colleagues' ones — provenance, not a role.
chatRouter.get("/", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const requestedOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 100)
        : null;
    const offset =
        Number.isFinite(requestedOffset) && requestedOffset > 0
            ? requestedOffset
            : 0;

    const result = await listChats(db, { userId, userEmail, limit, offset });
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json(result.data);
}));

// POST /chat/create
chatRouter.post("/create", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const parsedProjectId = parseOptionalProjectId(req.body?.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const projectId = parsedProjectId.value.projectId;
    const db = createServerSupabase();

    const result = await createChat(db, { userId, userEmail, projectId });
    if (!result.ok) {
        if (result.kind === "error")
            return void sendInternalError(res, result.error);
        return void res.status(result.status).json({ detail: result.detail });
    }
    res.json({ id: result.id });
}));

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    // Reading a chat only needs visibility (project.view) — org viewers
    // are allowed here even though they cannot write to the chat.
    const access = await getAccessibleChat(db, { chatId, userId, userEmail });
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });

    const messages = await getChatMessages(db, chatId);
    // access_role/is_owner mirror the project and review detail responses so
    // the client can render per-role affordances instead of re-deriving them.
    res.json({
        chat: access.chat,
        is_owner: access.isCreator,
        access_role: access.projectRole,
        messages,
    });
}));

// GET /chat/:chatId/people
// The chat's creator + every direct grantee, resolved to
// {email, display_name, role} — the same roster shape as
// GET /projects/:projectId/people, including its nullable `owner` (a chat in
// an organization project outlives its author's account). Visible to anyone
// who can see the chat.
chatRouter.get("/:chatId/people", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const access = await getAccessibleChat(db, { chatId, userId, userEmail });
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });

    const people = await listChatPeople(db, access.chat);
    if (!people.ok) return void sendInternalError(res, people.detail);
    res.json(people);
}));

// GET /chat/:chatId/access — role-aware direct grants, admin-only.
chatRouter.get("/:chatId/access", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const access = await getAccessibleChat(db, { chatId, userId, userEmail });
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    if (!can(access.projectRole, "access.manage"))
        return void res.status(403).json({
            detail: "Only a chat owner can change who has access.",
        });
    if (access.chat.project_id)
        return void res.json({
            scope: "project",
            inherited_from_project_id: access.chat.project_id,
            org_id: access.chat.org_id ?? null,
            access_role: access.projectRole,
            grants: [],
        });
    const listed = await listChatGrants(db, chatId);
    if (!listed.ok) return void sendInternalError(res, listed.detail);
    res.json({
        scope: "direct",
        org_id: null,
        access_role: access.projectRole,
        grants: listed.grants,
    });
}));

// POST /chat/:chatId/access — grant or re-role one recipient.
chatRouter.post("/:chatId/access", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const access = await getAccessibleChat(db, { chatId, userId, userEmail });
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    if (!can(access.projectRole, "access.manage"))
        return void res.status(403).json({
            detail: "Only a chat owner can change who has access.",
        });
    if (access.chat.project_id)
        return void res.status(409).json({
            code: "access_inherited",
            detail: "Project-owned chats inherit access from their project.",
        });
    const email = normalizeEmail(
        typeof req.body?.email === "string" ? req.body.email : null,
    );
    if (email && normalizeEmail(userEmail) === email)
        return void res
            .status(400)
            .json({ detail: "You cannot share a chat with yourself." });
    if (req.body?.role === "deny")
        return void res.status(400).json({
            detail: "Deny is only available for organization members",
        });
    const result = await grantChatAccess(db, {
        chatId,
        chat: access.chat,
        userId,
        email: req.body?.email,
        role: req.body?.role,
    });
    if (!result.ok) {
        if (result.kind === "validation")
            return void res.status(400).json({ detail: result.detail });
        return void sendInternalError(res, result.detail);
    }
    res.status(201).json(result.grant);
}));

// DELETE /chat/:chatId/access/:email — revoke one recipient.
chatRouter.delete("/:chatId/access/:email", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const access = await getAccessibleChat(db, { chatId, userId, userEmail });
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    if (!can(access.projectRole, "access.manage"))
        return void res.status(403).json({
            detail: "Only a chat owner can change who has access.",
        });
    if (access.chat.project_id)
        return void res.status(409).json({
            code: "access_inherited",
            detail: "Project-owned chats inherit access from their project.",
        });
    const result = await revokeChatAccess(db, {
        chatId,
        email: decodeURIComponent(req.params.email),
    });
    if (!result.ok) return void sendInternalError(res, result.detail);
    if (!result.removed)
        return void res.status(404).json({ detail: "Access grant not found" });
    res.status(204).send();
}));

// PATCH /chat/:chatId — rename and/or edit sharing.
chatRouter.patch("/:chatId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    let title: string | undefined;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};

    // Validate the SHAPE of what arrived instead of coercing it.
    // `String(req.body.title)` accepts anything: `{}` becomes the literal
    // title "[object Object]" and `42` becomes "42", so a client bug is
    // stored as data and discovered later by a human reading a nonsense chat
    // name. Refusing names the problem while it is still fixable.
    if (body.title != null) {
        if (typeof body.title !== "string")
            return void res
                .status(400)
                .json({ detail: "title must be a string" });
        const trimmed = body.title.trim();
        if (!trimmed)
            return void res.status(400).json({ detail: "title is required" });
        title = trimmed;
    }
    if ("shared_with" in body)
        return void res.status(400).json({
            detail:
                "shared_with is no longer supported; use the chat access endpoints.",
        });
    const hasModel = req.body.model != null;
    const parsedModel = parseOptionalModel(req.body.model);
    if (hasModel && !parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const hasReasoning = req.body.reasoningLevel != null;
    const parsedReasoning = parseOptionalReasoning(req.body.reasoningLevel);
    if (hasReasoning && !parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }

    if (title === undefined && !hasModel && !hasReasoning)
        return void res.status(400).json({
            detail: "title, model or reasoningLevel is required",
        });

    const db = createServerSupabase();
    const access = await getAccessibleChat(db, { chatId, userId, userEmail });
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    // Title edits are content collaboration (the same tier that already
    // rewrites titles via generate-title).
    if (title != null && !can(access.projectRole, "content.edit"))
        return void res
            .status(403)
            .json({ detail: "You do not have permission to modify this chat" });
    if ((hasModel || hasReasoning) && !can(access.projectRole, "content.edit"))
        return void res
            .status(403)
            .json({ detail: "You do not have permission to modify this chat" });

    const result = await updateChatSettings(db, {
        chatId,
        userId,
        chatModel: access.chat.model,
        ...(title !== undefined ? { title } : {}),
        ...(hasModel
            ? {
                  requestedModel: parsedModel.ok
                      ? parsedModel.value
                      : undefined,
              }
            : {}),
        ...(hasReasoning && parsedReasoning.ok && parsedReasoning.value
            ? { reasoningLevel: parsedReasoning.value }
            : {}),
    });
    if (!result.ok) {
        if (result.kind === "model")
            return void res
                .status(result.status)
                .json({ code: result.code, detail: result.detail });
        if (result.kind === "error")
            return void sendInternalError(res, result.error);
        return void res.status(404).json({ detail: "Chat not found" });
    }
    res.json(result.data);
}));

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    // container.delete keeps chat deletion at the top of the ladder: the
    // chat's creator, or an admin of the project it lives in (who could
    // already delete the whole project). Members and viewers get 403.
    const access = await getAccessibleChat(db, { chatId, userId, userEmail });
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    if (!can(access.projectRole, "container.delete"))
        return void res
            .status(403)
            .json({ detail: "You do not have permission to delete this chat" });

    const result = await deleteChat(db, { chatId });
    if (!result.ok) return void sendInternalError(res, result.error);
    res.status(204).send();
}));

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message =
        typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const requestedModel =
        typeof req.body?.model === "string" ? req.body.model.trim() : null;
    if (!message)
        return void res.status(400).json({ detail: "message is required" });
    const db = createServerSupabase();
    const access = await getAccessibleChat(db, { chatId, userId, userEmail });
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    // Generating a title UPDATEs the chat row — a write, so being able to
    // *see* the chat is not enough. Org viewers get 403 here.
    if (!can(access.projectRole, "content.edit"))
        return void res
            .status(403)
            .json({ detail: "You do not have permission to modify this chat" });

    const result = await generateChatTitle(db, {
        chatId,
        userId,
        chatModel: access.chat.model,
        message,
        requestedModel,
    });
    if (!result.ok) {
        if (result.kind === "model")
            return void res
                .status(result.status)
                .json({ code: result.code, detail: result.detail });
        return void res
            .status(500)
            .json({ detail: "Failed to generate title" });
    }
    res.json({ title: result.title });
}));

// POST /chat — streaming
chatRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessages = parseChatMessages(body.messages);
    if (!parsedMessages.ok) {
        return void res.status(400).json({ detail: parsedMessages.detail });
    }
    const parsedChatId = parseOptionalChatId(body.chat_id);
    if (!parsedChatId.ok) {
        return void res.status(400).json({ detail: parsedChatId.detail });
    }
    const parsedProjectId = parseOptionalProjectId(body.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(body.reasoning);
    if (!parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }
    const parsedAskInputsResponse = parseOptionalAskInputsResponse(
        body.ask_inputs_response,
    );
    if (!parsedAskInputsResponse.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAskInputsResponse.detail });
    }
    const messages = parsedMessages.value;
    const chat_id = parsedChatId.value;
    const project_id = parsedProjectId.value.projectId;
    const model = parsedModel.value;
    const askInputsResponse = parsedAskInputsResponse.value;
    // Reserve a stable assistant identity before streaming. This lets clients
    // associate streamed UI with the same durable message after a reload.
    const assistantMessageId = askInputsResponse ? null : randomUUID();
    const inputMessageId = askInputsResponse ? null : randomUUID();

    devLog("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        messageCount: messages?.length,
    });

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const prep = await prepareChatStream(db, {
        userId,
        userEmail,
        messages,
        chatId: chat_id ?? null,
        inputMessageId,
        projectIdProvided: parsedProjectId.value.provided,
        projectId: parsedProjectId.value.projectId,
        askInputsResponse,
        requestedModel: model,
        requestedReasoning: parsedReasoning.value,
    });
    if (!prep.ok) {
        if ("internal" in prep) return void sendInternalError(res, prep.error);
        return void res.status(prep.status).json({
            ...(prep.code ? { code: prep.code } : {}),
            detail: prep.detail,
        });
    }

    const {
        chatId,
        lastUser,
        resolvedProjectId,
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
    } = prep.prepared;
    let chatTitle = prep.prepared.chatTitle;
    let completedTurnPersisted = prep.prepared.completedTurnPersisted;
    let memoryTurnScheduled = false;

    devLog("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    try {
        // Make the advertised identity durable before the response becomes an
        // SSE stream. If this reservation fails, return a normal HTTP error
        // while headers are still mutable; clients must never receive an ID
        // that cannot subsequently be loaded from chat history.
        if (assistantMessageId) {
            const reserveError = await reserveAssistantMessage({
                db,
                table: "chat_messages",
                id: assistantMessageId,
                chatId,
                inputMessageId: inputMessageId as string,
                authorUserId: userId,
            });
            if (reserveError) {
                console.error(
                    "[chat/stream] failed to reserve assistant message",
                    reserveError,
                );
                return void res
                    .status(500)
                    .json({ detail: "Failed to start assistant response" });
            }
        }

        const stream = openAssistantSse(res);
        const write = stream.write;
        const updateReservedAssistantMessage =
            createReservedAssistantMessageUpdater({
                db,
                table: "chat_messages",
                id: assistantMessageId ?? "",
                chatId,
                enabled: !!assistantMessageId,
            });

        try {
            write(
                `data: ${JSON.stringify({
                    type: "chat_id",
                    chatId,
                    ...(assistantMessageId ? { assistantMessageId } : {}),
                })}\n\n`,
            );

            const shouldGenerateTitle =
                !chatTitle && !!lastUser?.content && !askInputsResponse;
            const titleMessage = lastUser
                ? [
                      lastUser.content,
                      lastUser.workflow
                          ? `Workflow: ${lastUser.workflow.title}`
                          : "",
                      lastUser.files?.length
                          ? `Files: ${lastUser.files.map((file) => file.filename).join(", ")}`
                          : "",
                  ]
                      .filter(Boolean)
                      .join("\n")
                : "";
            const titlePromise = shouldGenerateTitle
                ? generateAssistantChatTitle({
                      model: titleModelForChat(selectedModel, titleModel),
                      message: titleMessage,
                      apiKeys,
                  })
                      .then(async (title) => {
                          const saved = await updateChatTitle(db, {
                              chatId,
                              title,
                          });
                          if (!saved.ok) throw saved.error;
                          chatTitle = title;
                          if (!stream.signal.aborted) {
                              write(
                                  `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                              );
                          }
                      })
                      .catch((error) => {
                          console.error(
                              "[chat/stream] failed to generate chat title",
                              error,
                          );
                      })
                : Promise.resolve();

            const { fullText, events, citations } = await runLLMStream({
                apiMessages,
                docStore,
                docIndex,
                userId,
                db,
                write,
                allowDocumentMutation,
                workflowStore,
                includeResearchTools: legalResearchUs,
                model: selectedModel,
                reasoning: selectedReasoningLevel,
                apiKeys,
                signal: stream.signal,
                projectId: resolvedProjectId,
                includeMemory: true,
                memoryProjectId: canReadProjectMemory
                    ? resolvedProjectId
                    : null,
                memorySharedAudience,
                nonce,
                // This route first makes the advertised assistant ID durable.
                // It emits [DONE] only after the reserved row has been
                // populated.
                emitDone: false,
            });

            devLog("[chat/stream] LLM stream finished", {
                fullTextLen: fullText?.length ?? 0,
                eventCount: events?.length ?? 0,
            });

            // Upstream providers occasionally end the stream cleanly but empty
            // (observed via OpenRouter). Silence reads as a hung composer, so
            // surface it — unless tools produced visible artifacts, which carry
            // their own completion signal.
            if (
                !fullText?.trim() &&
                !events?.some((event) => event.type === "ask_inputs") &&
                (!events || events.every((event) => !("error" in event)))
            ) {
                write(
                    `data: ${JSON.stringify({
                        type: "error",
                        message:
                            "The model returned an empty response. Try again, or pick a different model.",
                        safe_to_display: true,
                    })}\n\n`,
                );
                write("data: [DONE]\n\n");
                return;
            }

            const persistedEvents = stripTransientAssistantEvents(events);
            if (askInputsResponse) {
                const appended = await appendAssistantEventsToMessage(
                    db,
                    chatId,
                    askInputsResponse.assistant_message_id,
                    userId,
                    persistedEvents,
                    citations,
                );
                completedTurnPersisted = appended;
            } else {
                const saveError = await updateReservedAssistantMessage(
                    persistedEvents.length ? persistedEvents : null,
                    citations.length ? citations : null,
                );
                if (saveError) {
                    console.error(
                        "[chat/stream] failed to save assistant response",
                        saveError,
                    );
                    write(
                        `data: ${JSON.stringify({
                            type: "error",
                            message:
                                "The response was generated but could not be saved.",
                        })}\n\n`,
                    );
                    write("data: [DONE]\n\n");
                    return;
                }
            }

            await titlePromise;

            if (!chatTitle && lastUser?.content) {
                const title = lastUser.content.slice(0, 120);
                await updateChatTitle(db, { chatId, title });
                chatTitle = title;
                if (shouldGenerateTitle && !stream.signal.aborted) {
                    write(
                        `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                    );
                }
            }

            // ask_inputs is an intentional pause, not a completed conversation.
            // A continuation reuses the preceding assistant row, so resolve that
            // durable identity only when there is no newly reserved message id.
            if (
                completedTurnPersisted &&
                !persistedEvents.some(
                    (event) =>
                        event.type === "ask_inputs" || event.type === "error",
                )
            ) {
                const completedTurnId =
                    assistantMessageId ??
                    askInputsResponse?.assistant_message_id ??
                    null;
                if (completedTurnId) {
                    const scheduled = await scheduleMemoryConsolidation({
                        db,
                        surface: "chat",
                        conversationId: chatId,
                        actorUserId: userId,
                        projectId: canCurateProjectMemory
                            ? resolvedProjectId
                            : null,
                        turnId: completedTurnId,
                        turn: memoryTurn,
                    });
                    memoryTurnScheduled = scheduled != null;
                }
            }
            void enqueueChatTurnAudit(
                db,
                {
                    userId,
                    userEmail,
                    chatId,
                    projectId: resolvedProjectId,
                    title:
                        chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
                    model: selectedModel,
                },
                persistedEvents,
            );
            write("data: [DONE]\n\n");
        } catch (err) {
            if (isAbortError(err)) {
                devLog("[chat/stream] client aborted stream", { chatId });
                void enqueueChatTurnAudit(
                    db,
                    {
                        userId,
                        userEmail,
                        chatId,
                        projectId: resolvedProjectId,
                        title: chatTitle,
                        model: selectedModel,
                        status: "cancelled",
                    },
                    null,
                );
                if (err instanceof AssistantStreamError) {
                    const partial = buildCancelledAssistantMessage({
                        fullText: err.fullText,
                        events: err.events,
                        buildCitations: (fullText) =>
                            extractCitations(fullText, docIndex),
                    });
                    const saveError = askInputsResponse
                        ? null
                        : await updateReservedAssistantMessage(
                              partial.events.length ? partial.events : null,
                              partial.citations.length
                                  ? partial.citations
                                  : null,
                          );
                    if (askInputsResponse) {
                        await appendAssistantEventsToMessage(
                            db,
                            chatId,
                            askInputsResponse.assistant_message_id,
                            userId,
                            partial.events,
                            partial.citations,
                        );
                    }
                    if (saveError) {
                        console.error(
                            "[chat/stream] failed to save aborted stream",
                            saveError,
                        );
                    }
                }
                return;
            }
            console.error("[chat/stream] error:", err);
            const message = ASSISTANT_ERROR_MESSAGE;
            const errorEvents =
                err instanceof AssistantStreamError
                    ? stripTransientAssistantEvents(err.events)
                    : [{ type: "error" as const, message }];
            const errorFullText =
                err instanceof AssistantStreamError ? err.fullText : "";
            try {
                const citations = extractCitations(errorFullText, docIndex);
                const saveError = askInputsResponse
                    ? null
                    : await updateReservedAssistantMessage(
                          errorEvents.length ? errorEvents : null,
                          citations.length ? citations : null,
                      );
                if (askInputsResponse) {
                    await appendAssistantEventsToMessage(
                        db,
                        chatId,
                        askInputsResponse.assistant_message_id,
                        userId,
                        errorEvents,
                        citations,
                    );
                }
                if (saveError)
                    console.error(
                        "[chat/stream] failed to save error",
                        saveError,
                    );
            } catch (saveErr) {
                console.error("[chat/stream] failed to save error", saveErr);
            }
            try {
                write(
                    `data: ${JSON.stringify({ type: "error", message })}\n\n`,
                );
                write("data: [DONE]\n\n");
            } catch {
                /* ignore */
            }
        } finally {
            stream.finish();
        }
    } finally {
        if (memoryTurn && !memoryTurnScheduled) {
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
    }
}));

chatRouter.use(routerErrorHandler("[chat]"));
