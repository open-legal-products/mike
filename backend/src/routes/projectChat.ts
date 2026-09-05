import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { enqueueChatTurnAudit } from "../lib/audit";
import {
    buildProjectDocContext,
    buildMessages,
    buildUserPersonalisationPrompt,
    buildWorkflowStore,
    enrichWithPriorEvents,
    appendAskInputsResponseToLastAssistantMessage,
    appendAssistantEventsToLastAssistantMessage,
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    extractCitations,
    generateSpotlightNonce,
    isAbortError,
    runLLMStream,
    spotlightFilename,
    stripTransientAssistantEvents,
    PROJECT_EXTRA_TOOLS,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalAttachedDocuments,
    parseOptionalChatId,
    parseOptionalDisplayedDoc,
    parseOptionalModel,
    parseOptionalReasoning,
    type ChatMessage,
} from "../lib/chat";
import { getUserModelSettings } from "../lib/userSettings";
import {
    checkProjectAccess,
    ensureChatAccess,
    resolveContentOrgId,
} from "../lib/access";
import { can, type ProjectRole } from "../lib/permissions";
import { generateAssistantChatTitle } from "../lib/chatTitle";
import {
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../lib/modelSelection";
import {
  beginMemoryConversationTurn,
  releaseMemoryConversationTurn,
  scheduleMemoryConsolidation,
  type MemoryConversationTurn,
} from "../lib/memory/schedule";
import { sendInternalError } from "../lib/httpError";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
Copies created with replicate_document are saved as project documents in this project. After replication, use the returned doc_id for any requested edits.`;

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
  const assistantMessageId = askInputsResponse ? null : randomUUID();
  const inputMessageId = askInputsResponse ? null : randomUUID();

    const db = createServerSupabase();

    // Verify the caller can reach the project at all. Whether they may WRITE
    // is decided below, once we know whether this is their own chat.
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res.status(404).json({ detail: "Project not found" });

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
    const allowDocumentMutation = can(
        projectAccess.projectRole,
        "content.edit",
    );

    let chatId = chat_id ?? null;
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
        }
    }

    // This verdict must precede model resolution: the model/reasoning
    // persistence below is a real UPDATE on the chats row, and running it
    // ahead of the gate would let a refused caller permanently change the
    // model on a thread they may not write to.
    if (!can(writeRole, "content.edit"))
        return void res.status(403).json({
            detail: "You do not have permission to write in this project.",
        });

    const modelSettings = await getUserModelSettings(userId, db);
    const modelResolution = await resolveEffectiveChatModel({
        requested: model,
        chatModel,
        lastSelectedModel: modelSettings.last_selected_chat_model,
        apiKeys: modelSettings.api_keys,
        userId,
        db,
    });
    if (!modelResolution.ok) {
        return void res.status(modelResolution.status).json({
            code: modelResolution.code,
            detail: modelResolution.detail,
        });
    }
    const selectedModel = modelResolution.model;
    const selectedReasoningLevel = resolveEffectiveReasoningLevel({
        model: selectedModel,
        requested: parsedReasoning.value,
        chatReasoningLevel,
        lastSelectedReasoningLevel: modelSettings.last_selected_reasoning_level,
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
            return void res
                .status(500)
                .json({ detail: "Failed to save chat model" });
        }
    }

    if (!chatId) {
        const resolvedOrg = await resolveContentOrgId(db, { projectId });
        if (!resolvedOrg.ok) {
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
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
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let completedTurnPersisted = true;
  let memoryTurn: MemoryConversationTurn | null = null;
  let memoryTurnScheduled = false;
    if (askInputsResponse) {
    completedTurnPersisted =
        await appendAskInputsResponseToLastAssistantMessage(
            db,
            chatId,
            askInputsResponse,
        userId,
        );
    if (!completedTurnPersisted) {
      return void res.status(500).json({ detail: "Failed to save message" });
    }
    } else if (lastUser) {
    const { error: userMessageError } = await db.from("chat_messages").insert({
      id: inputMessageId,
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
      author_user_id: userId,
        });
    if (userMessageError) {
      return void sendInternalError(res, userMessageError);
    }
    }

  if (askInputsResponse || lastUser) {
    try {
      memoryTurn = await beginMemoryConversationTurn({
        db,
        surface: "chat",
        conversationId: chatId,
        actorUserId: userId,
      });
    } catch (error) {
      return void sendInternalError(res, error);
    }
  }

  try {
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
        Object.entries(docIndex).map(
            ([slug, document]) =>
                [
                    document.document_id,
                    { slug, filename: document.filename },
                ] as const,
        ),
    );
    // Generate the nonce before adding request metadata or prior events so
    // every document filename is fenced wherever it enters the prompt.
    const nonce = generateSpotlightNonce();
    const documentPromptRef = (documentId: string, requestFilename: string) => {
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
                      const { error } = await db
                          .from("chats")
                          .update({ title })
                          .eq("id", chatId);
                      if (error) throw error;
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
            // Read-only collaborators keep the conversational surface
            // (read_document, find_in_document, list/fetch_documents, the
            // workflow and research tools) and lose only the writers.
            allowDocumentMutation,
            workflowStore,
            includeResearchTools: legalResearchUs,
            model: selectedModel,
            reasoning: selectedReasoningLevel,
            apiKeys,
            signal: streamAbort.signal,
            projectId,
            includeMemory: true,
            memoryProjectId: projectId,
            memorySharedAudience: true,
            nonce,
            emitDone: false,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        if (askInputsResponse) {
        const appended = await appendAssistantEventsToLastAssistantMessage(
                db,
                chatId,
                persistedEvents,
                citations,
            );
        completedTurnPersisted = completedTurnPersisted && appended;
        } else {
        const { error: saveError } = await db.from("chat_messages").insert({
          id: assistantMessageId,
                chat_id: chatId,
                role: "assistant",
                content: persistedEvents.length ? persistedEvents : null,
                citations: citations.length ? citations : null,
          author_user_id: userId,
          memory_input_message_id: inputMessageId,
            });
        if (saveError) {
          console.error(
            "[project-chat/stream] failed to save assistant response",
            saveError,
          );
          write(
            `data: ${JSON.stringify({
              type: "error",
              message: "The response was generated but could not be saved.",
            })}\n\n`,
          );
          write("data: [DONE]\n\n");
          return;
        }
        }

        await titlePromise;

        if (!chatTitle && lastUser?.content) {
            const title = lastUser.content.slice(0, 120);
            await db.from("chats").update({ title }).eq("id", chatId);
            chatTitle = title;
            if (shouldGenerateTitle && !streamAbort.signal.aborted) {
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }

      // A completed, durable assistant turn is the debounce trigger for the
      // asynchronous memory curator. ask_inputs is a pause, so continuations
      // resolve the existing assistant row and only schedule once it closes.
      if (
        completedTurnPersisted &&
        !persistedEvents.some(
          (event) => event.type === "ask_inputs" || event.type === "error",
        )
      ) {
        let completedTurnId = assistantMessageId;
        if (!completedTurnId) {
          const { data: latestAssistant } = await db
            .from("chat_messages")
            .select("id")
            .eq("chat_id", chatId)
            .eq("role", "assistant")
            .not("content", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          completedTurnId = latestAssistant?.id ?? null;
        }
        if (completedTurnId) {
          const scheduled = await scheduleMemoryConsolidation({
            db,
            surface: "chat",
            conversationId: chatId,
            actorUserId: userId,
            projectId: allowDocumentMutation ? projectId : null,
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
                const saveError = askInputsResponse
                    ? null
                    : (
                          await db.from("chat_messages").insert({
                  id: assistantMessageId,
                              chat_id: chatId,
                              role: "assistant",
                              content: partial.events.length
                                  ? partial.events
                                  : null,
                              citations: partial.citations.length
                                  ? partial.citations
                                  : null,
                  author_user_id: userId,
                  memory_input_message_id: inputMessageId,
                          })
                      ).error;
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
            const saveError = askInputsResponse
                ? null
                : (
                      await db.from("chat_messages").insert({
                id: assistantMessageId,
                          chat_id: chatId,
                          role: "assistant",
                          content: errorEvents.length ? errorEvents : null,
                          citations: citations.length ? citations : null,
                author_user_id: userId,
                memory_input_message_id: inputMessageId,
                      })
                  ).error;
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
        console.warn("[memory] project chat activity release failed", {
          chatId,
        });
      }
    }
  }
});
