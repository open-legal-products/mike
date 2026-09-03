// HTTP layer for the project-chat module.
//
// The route handler parses the request body, calls
// prepareProjectChatStream for the pre-stream DB work, and owns the SSE
// streaming loop (header flush, runLLMStream, abort handling,
// assistant-message persistence) — its ordering is delicate.

import { Router } from "express";
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
    PROJECT_EXTRA_TOOLS,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalAttachedDocuments,
    parseOptionalChatId,
    parseOptionalDisplayedDoc,
    parseOptionalModel,
    parseOptionalReasoning,
} from "../../lib/chat";
import { generateAssistantChatTitle } from "../chat/chat.service";
import { titleModelForChat } from "../../lib/modelSelection";
import {
    insertAssistantMessage,
    prepareProjectChatStream,
    updateChatTitle,
} from "./projectChat.service";

export const projectChatRouter = Router({ mergeParams: true });

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
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
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(body.reasoning);
    if (!parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }
    const parsedDisplayedDoc = parseOptionalDisplayedDoc(body.displayed_doc);
    if (!parsedDisplayedDoc.ok) {
        return void res.status(400).json({ detail: parsedDisplayedDoc.detail });
    }
    const parsedAttachedDocuments = parseOptionalAttachedDocuments(
        body.attached_documents,
    );
    if (!parsedAttachedDocuments.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAttachedDocuments.detail });
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
    const model = parsedModel.value;
    const displayed_doc = parsedDisplayedDoc.value;
    const attached_documents = parsedAttachedDocuments.value;
    const askInputsResponse = parsedAskInputsResponse.value;

    const db = createServerSupabase();

    const prep = await prepareProjectChatStream(db, {
        userId,
        userEmail,
        projectId,
        messages,
        chatId: chat_id ?? null,
        displayed_doc,
        attached_documents,
        askInputsResponse,
        requestedModel: model,
        requestedReasoning: parsedReasoning.value,
    });
    if (!prep.ok)
        return void res.status(prep.status).json({
            ...(prep.code ? { code: prep.code } : {}),
            detail: prep.detail,
        });

    const {
        chatId,
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
    } = prep.prepared;
    // Mutable: the title-generation flow below reassigns it once a title
    // has been persisted.
    let chatTitle = prep.prepared.chatTitle;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);
    const streamAbort = new AbortController();
    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) streamAbort.abort();
    });

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

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
                      if (!streamAbort.signal.aborted) {
                          write(
                              `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                          );
                      }
                  })
                  .catch((error) => {
                      console.error(
                          "[project-chat/stream] failed to generate chat title",
                          error,
                      );
                  })
            : Promise.resolve();

        const { events, citations } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            extraTools: PROJECT_EXTRA_TOOLS,
            workflowStore,
            includeResearchTools: legalResearchUs,
            model: selectedModel,
            reasoning: selectedReasoningLevel,
            apiKeys,
            signal: streamAbort.signal,
            projectId,
            nonce,
            emitDone: false,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        if (askInputsResponse) {
            await appendAssistantEventsToLastAssistantMessage(
                db,
                chatId,
                persistedEvents,
                citations,
            );
        } else {
            await insertAssistantMessage(db, {
                chatId,
                events: persistedEvents,
                citations,
            });
        }

        await titlePromise;

        if (!chatTitle && lastUser?.content) {
            const title = lastUser.content.slice(0, 120);
            await updateChatTitle(db, { chatId, title });
            chatTitle = title;
            if (shouldGenerateTitle && !streamAbort.signal.aborted) {
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
                projectId,
                title: chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
                model: selectedModel,
            },
            persistedEvents,
        );
        write("data: [DONE]\n\n");
    } catch (err) {
        if (isAbortError(err)) {
            console.log("[project-chat/stream] client aborted stream", {
                chatId,
            });
            if (err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractCitations(fullText, docIndex),
                });
                const saved = askInputsResponse
                    ? null
                    : await insertAssistantMessage(db, {
                          chatId,
                          events: partial.events,
                          citations: partial.citations,
                      });
                const saveError = saved && !saved.ok ? saved.error : null;
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
                        "[project-chat/stream] failed to save aborted stream",
                        saveError,
                    );
                }
            }
            return;
        }
        console.error("[project-chat/stream] error:", err);
        const message = ASSISTANT_ERROR_MESSAGE;
        const errorEvents =
            err instanceof AssistantStreamError
                ? stripTransientAssistantEvents(err.events)
                : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        try {
            const citations = extractCitations(errorFullText, docIndex);
            const saved = askInputsResponse
                ? null
                : await insertAssistantMessage(db, {
                      chatId,
                      events: errorEvents,
                      citations,
                  });
            const saveError = saved && !saved.ok ? saved.error : null;
            if (askInputsResponse) {
                await appendAssistantEventsToLastAssistantMessage(
                    db,
                    chatId,
                    errorEvents,
                    citations,
                );
            }
            if (saveError)
                console.error(
                    "[project-chat/stream] failed to save error",
                    saveError,
                );
        } catch (saveErr) {
            console.error(
                "[project-chat/stream] failed to save error",
                saveErr,
            );
        }
        try {
            write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        streamFinished = true;
        res.end();
    }
});
