// HTTP layer of the tabular-review module. Handlers parse and validate the
// request, call the module's service files, and map their typed results onto
// status codes. No handler queries the database.
//
// Two endpoints keep more than that, because streaming is an HTTP concern a
// return value cannot express: POST /:reviewId/generate keeps its SSE loop and
// abort/heartbeat wiring, and POST /:reviewId/chat keeps its SSE loop.
// Everything either of them does before the first frame and after the last one
// is a service call. (The async generate stream's loop is the module's one
// documented layering exception and lives in tabular.generateStream.ts — see
// the note in that file's header.)

import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { recordAudit } from "../../lib/audit";
import { sendInternalError } from "../../lib/httpError";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    TABULAR_TOOLS,
    type ChatMessage,
    parseOptionalModel,
    parseOptionalReasoning,
} from "../../lib/chat";
import {
    finishGeneration,
    startGenerationHeartbeat,
    type TabularFailure,
} from "./tabular.shared";
import {
    claimTabularGeneration,
    loadTabularGenerateWork,
    preparedGenerateFailure,
    prepareTabularGenerate,
    prepareTabularRunView,
} from "./tabular.generate";
import {
    claimCellsForGeneration,
    streamTabularGenerateAsync,
    streamTabularGenerateSync,
    streamTabularRunView,
} from "./tabular.generateStream";
import { type ReviewRow } from "./tabular.rows";
import {
    createTabularReview,
    deleteTabularReview,
    getTabularReviewDetail,
    getTabularReviewPeople,
    listTabularReviewIds,
    listTabularReviews,
    updateTabularReview,
    type DocumentGrouping,
} from "./tabular.reviews";
import {
    clearTabularReviewCells,
    regenerateTabularCell,
} from "./tabular.cells";
import {
    deleteTabularReviewChat,
    extractTabularAnnotations,
    listTabularReviewChatMessages,
    listTabularReviewChats,
    prepareTabularChat,
    saveTabularChatTurn,
    titleTabularChat,
    updateTabularReviewChat,
} from "./tabular.chats";
import { draftColumnPrompt } from "./tabular.prompt";
import { parsePaginationQuery } from "../../lib/pagination";
import { normalizeSearchTerm } from "../../lib/search";
import { parseTabularReviewSort } from "../../lib/sort";
import { parseTabularReviewScope } from "./tabular.overview";

export const tabularRouter = Router();
// The lease timings live in modules/tabular/tabular.shared.ts because the queue
// workers hold the same lease on the async path and must agree on them.

/**
 * Map a tabular service failure onto the response.
 *
 * Most failures speak the shared `ServiceFailure` vocabulary and go through
 * `sendServiceFailure`. `kind: "status"` carries the handful this module
 * answers with a status/body the shared table does not name — see the note in
 * tabular.shared.ts.
 */
function sendTabularFailure(res: Response, failure: TabularFailure): void {
    if (failure.kind === "status") {
        res.status(failure.status).json(failure.body);
        return;
    }
    sendServiceFailure(res, failure);
}

/** `?project_id=` as a filter, or null when it is absent or empty. */
function projectIdFilterOf(query: Record<string, unknown>): string | null {
    return typeof query.project_id === "string" && query.project_id
        ? query.project_id
        : null;
}

// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const result = await listTabularReviews(createServerSupabase(), {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
        projectIdFilter: projectIdFilterOf(query),
        scope: parseTabularReviewScope(query.scope),
        pagination: parsePaginationQuery(query),
        searchTerm: normalizeSearchTerm(query.search),
        sort: parseTabularReviewSort(query),
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.json(result.data);
});

// GET /tabular-review/ids (must come before /:reviewId routes)
// Lightweight id + owner list for every review matching the current
// filters — backs "select all matching" bulk actions so the client doesn't
// have to page through full review payloads just to collect checkboxes.
tabularRouter.get("/ids", requireAuth, async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const result = await listTabularReviewIds(createServerSupabase(), {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
        projectIdFilter: projectIdFilterOf(query),
        scope: parseTabularReviewScope(query.scope),
        searchTerm: normalizeSearchTerm(query.search),
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.json(result.data);
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    const {
        title,
        document_ids,
        columns_config,
        workflow_id,
        project_id,
        document_grouping,
        model,
    } = req.body as {
        title?: string;
        document_ids: string[];
        columns_config: { index: number; name: string; prompt: string }[];
        workflow_id?: string;
        project_id?: string;
        document_grouping?: DocumentGrouping;
        model?: string;
    };

    const result = await createTabularReview(createServerSupabase(), {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
        title,
        document_ids,
        columns_config,
        workflow_id,
        project_id,
        document_grouping,
        model,
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.status(201).json(result.data);
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
    const result = await draftColumnPrompt({
        userId: res.locals.userId as string,
        title: typeof req.body.title === "string" ? req.body.title.trim() : "",
        format: typeof req.body.format === "string" ? req.body.format : "text",
        documentName:
            typeof req.body.documentName === "string"
                ? req.body.documentName.trim()
                : "",
        tags: Array.isArray(req.body.tags)
            ? req.body.tags.filter((t: unknown) => typeof t === "string")
            : [],
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.json(result.data);
});

// GET /tabular-review/:reviewId
tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    const result = await getTabularReviewDetail(createServerSupabase(), {
        reviewId: req.params.reviewId,
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.json(result.data);
});

// GET /tabular-review/:reviewId/people
// Owner email + display_name plus member display_names — the analog of
// /projects/:id/people. Used by the standalone TR detail page's People
// modal so the roster can show display_names alongside emails.
tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    const result = await getTabularReviewPeople(createServerSupabase(), {
        reviewId: req.params.reviewId,
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.json(result.data);
});

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const result = await updateTabularReview(createServerSupabase(), {
        reviewId: req.params.reviewId,
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
        body: (req.body ?? {}) as Record<string, unknown>,
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.json(result.data);
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const result = await deleteTabularReview(createServerSupabase(), {
        reviewId: req.params.reviewId,
        userId: res.locals.userId as string,
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.status(204).send();
});

// POST /tabular-review/:reviewId/clear-cells
// Reset cells to an empty/pending state for the given row_ids. Does not
// delete the rows — it blanks `content` and sets `status` back to "pending".
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const { row_ids } = req.body as { row_ids?: string[] };
    if (!Array.isArray(row_ids) || row_ids.length === 0)
        return void res.status(400).json({ detail: "row_ids is required" });

    const result = await clearTabularReviewCells(createServerSupabase(), {
        reviewId: req.params.reviewId,
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
        rowIds: row_ids,
        log: console,
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.status(204).send();
});

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        const { row_id, column_index } = req.body as {
            row_id?: string;
            column_index: number;
        };
        if (!row_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "row_id and column_index are required" });

        const result = await regenerateTabularCell(createServerSupabase(), {
            reviewId: req.params.reviewId,
            userId: res.locals.userId as string,
            userEmail: res.locals.userEmail as string | undefined,
            rowId: row_id,
            columnIndex: column_index,
            log: console,
        });
        if (!result.ok) return void sendTabularFailure(res, result);
        res.status(result.data.status).json(result.data.body);
    },
);

// POST /tabular-review/:reviewId/generate
tabularRouter.post("/:reviewId/generate", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const generationAbort = new AbortController();
    const generationId = randomUUID();
    let leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
    req.on("aborted", () => generationAbort.abort());

    // Pre-lease guards only (review, access, columns, model policy). Row and
    // cell state is deliberately NOT read here — see the note at the lease
    // claim.
    const prepared = await prepareTabularGenerate(db, {
        reviewId,
        userId,
        userEmail,
    });
    if (!prepared.ok)
        return void sendTabularFailure(res, preparedGenerateFailure(prepared));
    const { columns, tabular_model, api_keys } = prepared.data;

    const expectedUpdatedAt = req.body?.expected_updated_at;
    if (
        typeof expectedUpdatedAt !== "string" ||
        !Number.isFinite(Date.parse(expectedUpdatedAt))
    ) {
        return void res.status(400).json({
            detail: "expected_updated_at must be a valid timestamp",
        });
    }
    if (generationAbort.signal.aborted || res.destroyed) return;

    const claim = await claimTabularGeneration(db, {
        reviewId,
        expectedUpdatedAt,
        generationId,
    });
    if (!claim.ok) return void sendTabularFailure(res, claim);

    // Everything used to decide which cells need work is loaded only after
    // the atomic lease claim. Otherwise, a request can snapshot pending cells
    // while another run is finishing, acquire the newly released lease, and
    // regenerate results that were completed after its stale snapshot.
    let rows: ReviewRow[] = [];
    let cellMap = new Map<string, Record<string, unknown>>();

    // The async path hands the lease to the queue workers (they renew it, and
    // the last one out releases it) because the work outlives this request.
    // While that is true this handler must neither release the lease nor end
    // the response in its `finally`.
    let leaseHandedOff = false;
    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) generationAbort.abort();
    });
    const write = (line: string) => {
        if (res.destroyed || res.writableEnded) return false;
        return res.write(line);
    };

    try {
        // Losing the lease means a successor now owns these cells, so the
        // only safe response is to stop writing: abort, and let `finally`
        // close the stream.
        leaseHeartbeat = startGenerationHeartbeat({
            db,
            reviewId,
            generationId,
            skip: () => generationAbort.signal.aborted,
            onLost: () => generationAbort.abort(),
        });

        const work = await loadTabularGenerateWork(db, {
            reviewId,
            userId,
            userEmail,
        });
        if (!work.ok) {
            sendInternalError(res, work.error);
            return;
        }
        rows = work.data.rows;
        cellMap = work.data.cellMap;

        if (generationAbort.signal.aborted || res.destroyed) return;

        // Async path: hand extraction to the durable BullMQ queue and turn this
        // request into a reconnectable view that tails progress. The work
        // survives a disconnect and retries on failure. Falls through to the
        // historical inline path when the flag is off (no Redis required).
        if (process.env.ASYNC_TABULAR_EXTRACTION === "true") {
            // The workers renew the lease from here on, so stop our heartbeat
            // before handing over — two renewers would just race each other.
            if (leaseHeartbeat) {
                clearInterval(leaseHeartbeat);
                leaseHeartbeat = null;
            }
            leaseHandedOff = await streamTabularGenerateAsync({
                res,
                db,
                reviewId,
                userId,
                generationId,
                columns,
                rows,
                cellMap,
                log: console,
            });
            void recordAudit(db, {
                userId,
                userEmail,
                action: "tabular.generated",
                surface: "tabular",
                reviewId,
            });
            return;
        }

        // Synchronous path: claim the cells this run intends to fill by
        // stamping them with the generation id — the same call the async path
        // makes before enqueuing. Every write extractRowColumns then performs
        // is guarded on that stamp, so a run that loses the lease mid-flight
        // (a wedged process, a renew that failed) can no longer blank or
        // overwrite the cells its successor has already filled. Doing it here,
        // right after the atomic lease claim, is the only window in which no
        // other generation can be running.
        try {
            await claimCellsForGeneration({
                db,
                reviewId,
                generationId,
                columns,
                rows,
                cellMap,
            });
        } catch (claimErr) {
            sendInternalError(res, claimErr);
            return;
        }

        const completed = await streamTabularGenerateSync({
            res,
            db,
            reviewId,
            columns,
            rows,
            cellMap,
            model: tabular_model,
            apiKeys: api_keys,
            generationId,
            abortSignal: generationAbort.signal,
        });

        if (completed) {
            void recordAudit(db, {
                userId,
                userEmail,
                action: "tabular.generated",
                surface: "tabular",
                reviewId,
                model: tabular_model,
            });
            write("data: [DONE]\n\n");
        }
    } catch (err) {
        if (!generationAbort.signal.aborted) {
            console.error("[tabular/generate] stream error", err);
            if (res.headersSent) {
                try {
                    write(
                        `data: ${JSON.stringify({ type: "error", message: ASSISTANT_ERROR_MESSAGE })}\n\ndata: [DONE]\n\n`,
                    );
                } catch {
                    /* ignore */
                }
            } else if (!res.destroyed && !res.writableEnded) {
                res.status(500).json({
                    detail: "Failed to prepare tabular review generation",
                });
            }
        }
    } finally {
        streamFinished = true;
        if (leaseHeartbeat) clearInterval(leaseHeartbeat);
        // On the async path the lease now belongs to the workers and the SSE
        // view is still tailing them, so neither is ours to close.
        if (!leaseHandedOff) {
            await finishGeneration(
                db,
                reviewId,
                generationId,
                console,
                "[tabular/generate]",
            );
            if (!res.writableEnded) res.end();
        }
    }
});

// GET /tabular-review/:reviewId/generate/stream — reconnect to an in-flight (or
// just-finished) generate run without re-triggering work. A client whose POST
// /generate stream dropped can resume here and catch up on the remaining cells.
// Pure observer: it never enqueues and takes NO generation lease, so watching a
// run can never block it or make a legitimate POST 409. (Registered before the
// /:reviewId/chats group; no path collision since the segments differ.)
tabularRouter.get(
    "/:reviewId/generate/stream",
    requireAuth,
    async (req, res) => {
        const { reviewId } = req.params;
        const db = createServerSupabase();
        const view = await prepareTabularRunView(db, {
            reviewId,
            userId: res.locals.userId as string,
            userEmail: res.locals.userEmail as string | undefined,
        });
        if (!view.ok) return void sendTabularFailure(res, view);

        await streamTabularRunView({
            res,
            db,
            reviewId,
            columns: view.data.columns,
            rows: view.data.rows,
            cellMap: view.data.cellMap,
            log: console,
        });
    },
);

// GET /tabular-review/:reviewId/chats — list chats (metadata only, no messages)
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const result = await listTabularReviewChats(createServerSupabase(), {
        reviewId: req.params.reviewId,
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendTabularFailure(res, result);
    res.json(result.data);
});

// DELETE /tabular-review/:reviewId/chats/:chatId — delete a single chat
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const result = await deleteTabularReviewChat(createServerSupabase(), {
            chatId: req.params.chatId,
            userId: res.locals.userId as string,
        });
        if (!result.ok) return void sendTabularFailure(res, result);
        res.status(204).send();
    },
);

// PATCH /tabular-review/:reviewId/chats/:chatId — update chat settings
tabularRouter.patch(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const result = await updateTabularReviewChat(createServerSupabase(), {
            reviewId: req.params.reviewId,
            chatId: req.params.chatId,
            userId: res.locals.userId as string,
            body:
                req.body &&
                typeof req.body === "object" &&
                !Array.isArray(req.body)
                    ? (req.body as Record<string, unknown>)
                    : {},
        });
        if (!result.ok) return void sendTabularFailure(res, result);
        res.json(result.data);
    },
);

// GET /tabular-review/:reviewId/chats/:chatId/messages — messages for a single chat
tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        const result = await listTabularReviewChatMessages(
            createServerSupabase(),
            {
                reviewId: req.params.reviewId,
                chatId: req.params.chatId,
                userId: res.locals.userId as string,
                userEmail: res.locals.userEmail as string | undefined,
            },
        );
        if (!result.ok) return void sendTabularFailure(res, result);
        res.json(result.data);
    },
);

// ---------------------------------------------------------------------------
// POST /tabular-review/:reviewId/chat — agentic streaming
// ---------------------------------------------------------------------------

// POST /tabular-review/:reviewId/chat
tabularRouter.post("/:reviewId/chat", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const {
        messages,
        chat_id: existingChatId,
        review_title: clientReviewTitle,
        project_name: clientProjectName,
        model: rawModel,
        reasoning: rawReasoning,
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        review_title?: string;
        project_name?: string;
        model?: unknown;
        reasoning?: unknown;
    };

    const parsedModel = parseOptionalModel(rawModel);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(rawReasoning);
    if (!parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }

    const lastUser = [...(messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
    if (!lastUser?.content?.trim()) {
        return void res
            .status(400)
            .json({ detail: "messages must include a user message" });
    }

    const db = createServerSupabase();
    // Everything before the first SSE byte: the review and its grid, the chat
    // record, the model policy, the persisted user turn, the prompt.
    const preparation = await prepareTabularChat(db, {
        reviewId,
        userId,
        userEmail,
        messages,
        lastUserContent: lastUser.content,
        chatId: existingChatId,
        requestedModel: parsedModel.value,
        requestedReasoning: parsedReasoning.value,
    });
    if (!preparation.ok) return void sendTabularFailure(res, preparation);
    const {
        apiMessages,
        apiKeys: api_keys,
        chatId,
        chatTitle,
        isFirstExchange,
        model: selectedChatModel,
        reasoningLevel: selectedReasoningLevel,
        reviewTitle,
        tabularStore,
        titleModel,
    } = preparation.data;

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

    if (chatId) {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);
    }

    try {
        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            db,
            write,
            extraTools: TABULAR_TOOLS,
            includeResearchTools: false,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore),
            model: selectedChatModel,
            reasoning: selectedReasoningLevel,
            apiKeys: api_keys,
            signal: streamAbort.signal,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            await saveTabularChatTurn(db, {
                chatId,
                content: persistedEvents,
                annotations,
                touch: true,
            });
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const title = await titleTabularChat(db, {
                chatId,
                titleModel,
                userContent: lastUser.content,
                reviewTitle: clientReviewTitle ?? reviewTitle ?? null,
                projectName: clientProjectName ?? null,
                apiKeys: api_keys,
            });
            if (title) {
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }
    } catch (err) {
        if (isAbortError(err)) {
            console.log("[tabular/chat] client aborted stream", { chatId });
            if (chatId && err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractTabularAnnotations(fullText, tabularStore),
                });
                const saveError = await saveTabularChatTurn(db, {
                    chatId,
                    content: partial.events,
                    annotations: partial.citations,
                    touch: true,
                });
                if (saveError)
                    console.error(
                        "[tabular/chat] failed to save aborted stream",
                        saveError,
                    );
            }
            return;
        }
        console.error("[tabular/chat] error", err);
        const message = ASSISTANT_ERROR_MESSAGE;
        const errorEvents =
            err instanceof AssistantStreamError
                ? stripTransientAssistantEvents(err.events)
                : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        if (chatId) {
            try {
                const saveError = await saveTabularChatTurn(db, {
                    chatId,
                    content: errorEvents,
                    annotations: extractTabularAnnotations(
                        errorFullText,
                        tabularStore,
                    ),
                    touch: false,
                });
                if (saveError)
                    console.error(
                        "[tabular/chat] failed to save error",
                        saveError,
                    );
            } catch (saveErr) {
                console.error("[tabular/chat] failed to save error", saveErr);
            }
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
