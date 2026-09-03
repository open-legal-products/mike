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
import { createServerSupabase } from "../../lib/supabase";
import { enqueueChatTurnAudit } from "../../lib/audit";
import {
    appendAssistantEventsToLastAssistantMessage,
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
    openAssistantSse,
    reserveAssistantMessage,
} from "../../lib/chat";
import { generateAssistantChatTitle } from "./chat.title";
import { sendInternalError } from "../../lib/httpError";
import { titleModelForChat } from "../../lib/modelSelection";
import {
    createChat,
    deleteChat,
    devLog,
    generateChatTitle,
    getChatWithMessages,
    listChats,
    prepareChatStream,
    updateChatSettings,
    updateChatTitle,
} from "./chat.service";

export const chatRouter = Router();

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
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

    const result = await listChats(db, { userId, limit, offset });
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json(result.data);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
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
        return void res
            .status(result.status)
            .json({ detail: result.detail });
    }
    res.json({ id: result.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const result = await getChatWithMessages(db, { chatId, userId, userEmail });
    if (!result.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json({ chat: result.chat, messages: result.messages });
});

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const invalidField = Object.keys(body).find(
        (field) =>
            field !== "title" &&
            field !== "model" &&
            field !== "reasoningLevel",
    );
    if (invalidField) {
        return void res
            .status(400)
            .json({ detail: `Unsupported chat field: ${invalidField}` });
    }
    const hasTitle = Object.hasOwn(body, "title");
    const hasModel = Object.hasOwn(body, "model");
    const hasReasoning = Object.hasOwn(body, "reasoningLevel");
    if (!hasTitle && !hasModel && !hasReasoning) {
        return void res
            .status(400)
            .json({ detail: "title, model, or reasoningLevel is required" });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (hasTitle && !title) {
        return void res.status(400).json({ detail: "title is required" });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (hasModel && !parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(body.reasoningLevel);
    if (hasReasoning && !parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }

    const db = createServerSupabase();
    const result = await updateChatSettings(db, {
        chatId,
        userId,
        userEmail,
        ...(hasTitle ? { title } : {}),
        ...(hasModel
            ? { requestedModel: parsedModel.ok ? parsedModel.value : null }
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
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const result = await deleteChat(db, { chatId, userId });
    if (!result.ok) return void sendInternalError(res, result.error);
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
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
    const result = await generateChatTitle(db, {
        chatId,
        userId,
        userEmail,
        message,
        requestedModel,
    });
    if (!result.ok) {
        if (result.kind === "not_found")
            return void res.status(404).json({ detail: "Chat not found" });
        if (result.kind === "model")
            return void res
                .status(result.status)
                .json({ code: result.code, detail: result.detail });
        return void res
            .status(500)
            .json({ detail: "Failed to generate title" });
    }
    res.json({ title: result.title });
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
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

    devLog("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    // Make the advertised identity durable before the response becomes an
    // SSE stream. If this reservation fails, return a normal HTTP error while
    // headers are still mutable; clients must never receive an ID that cannot
    // subsequently be loaded from chat history.
    if (assistantMessageId) {
        const reserveError = await reserveAssistantMessage({
            db,
            table: "chat_messages",
            id: assistantMessageId,
            chatId,
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
            workflowStore,
            includeResearchTools: legalResearchUs,
            model: selectedModel,
            reasoning: selectedReasoningLevel,
            apiKeys,
            signal: stream.signal,
            projectId: resolvedProjectId,
            nonce,
            // This route first makes the advertised assistant ID durable.
            // It emits [DONE] only after the reserved row has been populated.
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
            await appendAssistantEventsToLastAssistantMessage(
                db,
                chatId,
                persistedEvents,
                citations,
            );
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
        void enqueueChatTurnAudit(
            db,
            {
                userId,
                userEmail,
                chatId,
                projectId: resolvedProjectId,
                title: chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
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
                          partial.citations.length ? partial.citations : null,
                      );
                if (askInputsResponse) {
                    await appendAssistantEventsToLastAssistantMessage(
                        db,
                        chatId,
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
                await appendAssistantEventsToLastAssistantMessage(
                    db,
                    chatId,
                    errorEvents,
                    citations,
                );
            }
            if (saveError)
                console.error("[chat/stream] failed to save error", saveError);
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
});
