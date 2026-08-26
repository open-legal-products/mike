// HTTP layer of the tabular-review module. Handlers parse and validate the
// request, delegate to the module's service files, and map typed results onto
// status codes. Streaming endpoints (generate, chat) keep their SSE loops here;
// their non-streaming prepare/persist logic lives in the service files.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { recordAudit } from "../../lib/audit";
import { sendInternalError } from "../../lib/httpError";
import {
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    TABULAR_TOOLS,
    type ChatMessage,
    type TabularCellStore,
} from "../../lib/chat";
import { completeText } from "../../lib/llm";
import {
    generateChatTitle,
    queryTabularCell,
} from "./tabular.extract";
import {
    missingModelApiKey,
    parseCellContent,
    TABULAR_GENERATION_HEARTBEAT_MS,
    TABULAR_GENERATION_LEASE_SECONDS,
    type Column,
} from "./tabular.shared";
import {
    extractRowColumns,
    finalizeCell,
} from "./tabular.extractRow";
import {
    loadTabularGenerateWork,
    prepareTabularGenerate,
} from "./tabular.generate";
import {
    awaitCellTerminal,
    streamTabularGenerateAsync,
    streamTabularRunView,
} from "./tabular.generateStream";
import {
    enqueueExtraction,
    removeQueuedExtractionJobs,
} from "../../lib/queue/extractionQueue";
import {
    loadReviewRows,
    loadRowDocumentText,
    type ReviewRow,
} from "./tabular.rows";
import {
    createRowsForReview,
    normalizeGrouping,
    rebuildRowsForReview,
    syncCellsForReviewRows,
    type DocumentGrouping,
} from "./tabular.reviews";
import {
    buildTabularMessages,
    extractTabularAnnotations,
} from "./tabular.chats";
import { getUserModelSettings } from "../../lib/userSettings";
import {
    checkProjectAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
} from "../../lib/access";
import {
    findMissingUserEmails,
    loadProfileUsersByEmail,
} from "../../lib/userLookup";
import { parsePaginationQuery } from "../../lib/pagination";
import { normalizeSearchTerm } from "../../lib/search";
import { parseTabularReviewSort } from "../../lib/sort";
import {
    buildTabularReviewIdsOverviewRpcArgs,
    buildTabularReviewsOverviewRpcArgs,
    parseTabularReviewScope,
} from "../../lib/tabularReviewsOverview";
import { attachActiveVersionPaths } from "../../lib/documentVersions";

export const tabularRouter = Router();
const TABULAR_GENERATION_CONCURRENCY = 3;
// The lease timings live in modules/tabular/tabular.shared.ts because the queue
// workers hold the same lease on the async path and must agree on them.

function isReviewGenerationRunning(review: Record<string, unknown>): boolean {
    if (!review.active_generation_id || !review.generation_lease_expires_at) {
        return false;
    }
    const leaseExpiresAt = Date.parse(
        String(review.generation_lease_expires_at),
    );
    return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now();
}

// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    const rpcArgs = buildTabularReviewsOverviewRpcArgs({
        userId,
        userEmail,
        projectIdFilter,
        scope: parseTabularReviewScope(req.query.scope),
        pagination: parsePaginationQuery(req.query as Record<string, unknown>),
        searchTerm: normalizeSearchTerm(req.query.search),
        sort: parseTabularReviewSort(req.query as Record<string, unknown>),
    });

    const { data, error } = await db.rpc(
        "get_tabular_reviews_overview",
        rpcArgs,
    );
    if (error) return void sendInternalError(res, error);

    res.json(data ?? []);
});

// GET /tabular-review/ids (must come before /:reviewId routes)
// Lightweight id + owner list for every review matching the current
// filters — backs "select all matching" bulk actions so the client doesn't
// have to page through full review payloads just to collect checkboxes.
//
// PostgREST enforces its own row cap on every RPC response (db-max-rows),
// independent of anything this route asks for, and truncates silently
// (206 + a shorter array, no error) rather than failing. So this pages
// through the RPC itself — server-side, same-datacenter round trips — until
// a page comes back empty, rather than trusting one call to return
// everything.
const TABULAR_REVIEW_IDS_PAGE_SIZE = 1000;
const TABULAR_REVIEW_IDS_MAX_PAGES = 200; // guards a runaway loop, not a product limit

tabularRouter.get("/ids", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;
    const searchTerm = normalizeSearchTerm(req.query.search);
    const scope = parseTabularReviewScope(req.query.scope);

    const ids: { id: string; user_id: string }[] = [];
    let offset = 0;
    for (let page = 0; page < TABULAR_REVIEW_IDS_MAX_PAGES; page++) {
        const rpcArgs = buildTabularReviewIdsOverviewRpcArgs({
            userId,
            userEmail,
            projectIdFilter,
            scope,
            searchTerm,
            pagination: { limit: TABULAR_REVIEW_IDS_PAGE_SIZE, offset },
        });
        const { data, error } = await db.rpc(
            "get_tabular_review_ids_overview",
            rpcArgs,
        );
        if (error) return void sendInternalError(res, error);

        const rows = (data ?? []) as { id: string; user_id: string }[];
        if (rows.length === 0) break;
        ids.push(...rows);
        offset += rows.length;
    }

    res.json(ids);
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const {
        title,
        document_ids,
        columns_config,
        workflow_id,
        project_id,
        document_grouping,
    } = req.body as {
        title?: string;
        document_ids: string[];
        columns_config: { index: number; name: string; prompt: string }[];
        workflow_id?: string;
        project_id?: string;
        document_grouping?: DocumentGrouping;
    };

    const db = createServerSupabase();
    if (project_id) {
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
    }
    const allowedDocumentIds = Array.isArray(document_ids)
        ? await filterAccessibleDocumentIds(document_ids, userId, userEmail, db)
        : [];
    const grouping = normalizeGrouping(document_grouping);
    const { data: review, error } = await db
        .from("tabular_reviews")
        .insert({
            user_id: userId,
            title: title ?? null,
            columns_config,
            document_ids: allowedDocumentIds,
            project_id: project_id ?? null,
            workflow_id: workflow_id ?? null,
            document_grouping: grouping,
        })
        .select("*")
        .single();
    if (error || !review)
        return void sendInternalError(
            res,
            error ?? new Error("Review create returned no data"),
        );

    try {
        await createRowsForReview(
            db,
            review.id,
            userId,
            allowedDocumentIds,
            columns_config,
            grouping,
        );
    } catch (error) {
        await db.from("tabular_reviews").delete().eq("id", review.id);
        return void res.status(500).json({
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to create review rows",
        });
    }

    void recordAudit(db, {
        userId,
        userEmail,
        action: "tabular.created",
        title: (review as { title?: string | null }).title ?? null,
        surface: "tabular",
        projectId: project_id ?? null,
        reviewId: (review as { id: string }).id,
    });
    res.status(201).json(review);
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const title =
        typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const format: string =
        typeof req.body.format === "string" ? req.body.format : "text";
    const documentName: string =
        typeof req.body.documentName === "string"
            ? req.body.documentName.trim()
            : "";
    const tags: string[] = Array.isArray(req.body.tags)
        ? req.body.tags.filter((t: unknown) => typeof t === "string")
        : [];

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        // Hand the request's client over, as every other call site does,
        // instead of letting the helper build its own.
        const { title_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        const raw = await completeText({
            model: title_model,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            res.json({ prompt: parsed.prompt.trim(), source: "llm" });
        } else {
            res.status(502).json({ detail: "LLM returned an empty prompt" });
        }
    } catch {
        res.status(502).json({ detail: "Failed to generate prompt from LLM" });
    }
});

// GET /tabular-review/:reviewId
tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { data: cells, error: cellsError } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    if (cellsError)
        return void sendInternalError(res, cellsError);
    const rows = await loadReviewRows(db, reviewId);
    const rowDocIds = rows.flatMap((row) => row.source_document_ids ?? []);
    const docIds = Array.isArray(review.document_ids)
        ? (review.document_ids as string[])
        : rowDocIds;
    const docsResult =
        docIds.length > 0
            ? await db.from("documents").select("*").in("id", docIds)
            : { data: [] as Record<string, unknown>[] };
    const docs = (docsResult.data ?? []) as unknown as {
        id: string;
        current_version_id?: string | null;
    }[];
    await attachActiveVersionPaths(db, docs);
    const clientReview = { ...review };
    delete clientReview.active_generation_id;
    delete clientReview.generation_lease_expires_at;

    res.json({
        review: {
            ...clientReview,
            is_owner: access.isOwner,
            is_running: isReviewGenerationRunning(review),
        },
        cells: (cells ?? []).map((cell) => ({
            ...cell,
            content: parseCellContent(cell.content),
        })),
        rows,
        documents: docs,
    });
});

// GET /tabular-review/:reviewId/people
// Owner email + display_name plus member display_names — the analog of
// /projects/:id/people. Used by the standalone TR detail page's People
// modal so the roster can show display_names alongside emails.
tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, shared_with")
        .eq("id", reviewId)
        .single();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const sharedWith: string[] = (
        Array.isArray(review.shared_with)
            ? (review.shared_with as string[])
            : []
    ).map((e) => (e ?? "").toLowerCase());

    // Use the mirrored profile email so sharing checks do not scan auth.users.
    const { userByEmail, userById } = await loadProfileUsersByEmail(db);

    const ownerInfo = userById.get(review.user_id as string);
    res.json({
        owner: {
            user_id: review.user_id,
            email: ownerInfo?.email ?? null,
            display_name: ownerInfo?.display_name ?? null,
        },
        members: sharedWith.map((email) => {
            const u = userByEmail.get(email);
            const display_name = u?.display_name ?? null;
            return { email, display_name };
        }),
    });
});

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const updates: Record<string, unknown> = {};
    if (req.body.title != null) updates.title = req.body.title;
    const projectIdUpdateProvided = req.body.project_id !== undefined;
    const projectIdUpdate =
        req.body.project_id === null
            ? null
            : typeof req.body.project_id === "string" &&
                req.body.project_id.trim()
              ? req.body.project_id.trim()
              : undefined;
    if (projectIdUpdateProvided && projectIdUpdate === undefined) {
        return void res.status(400).json({
            detail: "project_id must be a non-empty string or null",
        });
    }
    // shared_with edits are owner-only — gated below after we know who's
    // making the call. Normalize lowercase + dedupe + drop empties.
    let sharedWithUpdate: string[] | undefined;
    if (Array.isArray(req.body.shared_with)) {
        const normalizedUserEmail = userEmail?.trim().toLowerCase();
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const raw of req.body.shared_with) {
            if (typeof raw !== "string") continue;
            const e = raw.trim().toLowerCase();
            if (!e || seen.has(e)) continue;
            if (normalizedUserEmail && e === normalizedUserEmail) {
                return void res.status(400).json({
                    detail: "You cannot share a tabular review with yourself.",
                });
            }
            seen.add(e);
            cleaned.push(e);
        }
        sharedWithUpdate = cleaned;
    }
    updates.updated_at = new Date().toISOString();

    const db = createServerSupabase();
    const { data: existingReview, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !existingReview)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        existingReview,
        userId,
        userEmail,
        db,
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (
        (req.body.title != null ||
            req.body.document_ids != null ||
            req.body.document_grouping != null) &&
        !access.isOwner
    ) {
        return void res.status(403).json({
            detail: "Only the review owner can change review settings",
        });
    }
    if (req.body.columns_config != null) {
        if (!access.isOwner) {
            return void res.status(403).json({
                detail: "Only the review owner can change columns",
            });
        }
        updates.columns_config = req.body.columns_config;
    }
    if (req.body.document_grouping != null) {
        if (
            req.body.document_grouping !== "document" &&
            req.body.document_grouping !== "folder"
        ) {
            return void res.status(400).json({
                detail: "document_grouping must be document or folder",
            });
        }
        updates.document_grouping = req.body.document_grouping;
    }
    if (Array.isArray(req.body.document_ids)) {
        updates.document_ids = await filterAccessibleDocumentIds(
            req.body.document_ids,
            userId,
            userEmail,
            db,
        );
    }
    if (sharedWithUpdate !== undefined) {
        if (!access.isOwner)
            return void res
                .status(403)
                .json({ detail: "Only the review owner can change sharing" });
        const missingSharedUsers = await findMissingUserEmails(
            db,
            sharedWithUpdate,
        );
        if (missingSharedUsers.length > 0) {
            return void res.status(400).json({
                detail: `${missingSharedUsers[0]} does not belong to a Mike user.`,
            });
        }
        updates.shared_with = sharedWithUpdate;
    }
    if (projectIdUpdateProvided) {
        if (!access.isOwner) {
            return void res.status(403).json({
                detail: "Only the review owner can move a review",
            });
        }
        if (projectIdUpdate) {
            const projectAccess = await checkProjectAccess(
                projectIdUpdate,
                userId,
                userEmail,
                db,
            );
            if (!projectAccess.ok) {
                return void res
                    .status(404)
                    .json({ detail: "Target project not found" });
            }
        }
        updates.project_id = projectIdUpdate;
    }

    const { data: updatedReview, error: updateError } = await db
        .from("tabular_reviews")
        .update(updates)
        .eq("id", reviewId)
        .select("*")
        .single();
    if (updateError || !updatedReview)
        return void sendInternalError(
            res,
            updateError ?? new Error("Review update returned no data"),
        );

    const rowShapeChanged =
        Array.isArray(req.body.document_ids) ||
        req.body.document_grouping != null ||
        projectIdUpdateProvided;
    try {
        const activeColumns = (updatedReview.columns_config ?? []) as Column[];
        if (rowShapeChanged) {
            await rebuildRowsForReview(
                db,
                reviewId,
                userId,
                (updatedReview.document_ids ?? []) as string[],
                activeColumns,
                normalizeGrouping(updatedReview.document_grouping),
            );
        } else if (Array.isArray(req.body.columns_config)) {
            await syncCellsForReviewRows(db, reviewId, activeColumns);
        }
    } catch (error) {
        return void res.status(500).json({
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to synchronize review rows",
        });
    }

    res.json(updatedReview);
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    // Select the deleted ids back: without them a delete that matched nothing
    // (wrong id, or someone else's review) reported 204 "deleted".
    const { data: deleted, error } = await db
        .from("tabular_reviews")
        .delete()
        .eq("id", reviewId)
        .eq("user_id", userId)
        // Selecting the deleted ids separates "gone now" from "was never
        // yours": a collaborator deleting a shared review used to get 204 for
        // a no-op, and the row stayed on their screen until a reload.
        .select("id");
    if (error) return void sendInternalError(res, error);
    if (!deleted || deleted.length === 0)
        return void res.status(404).json({ detail: "Review not found" });
    res.status(204).send();
});

// POST /tabular-review/:reviewId/clear-cells
// Reset cells to an empty/pending state for the given row_ids. Does not
// delete the rows — it blanks `content` and sets `status` back to "pending".
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const { row_ids } = req.body as { row_ids?: string[] };

    if (!Array.isArray(row_ids) || row_ids.length === 0)
        return void res.status(400).json({ detail: "row_ids is required" });

    const db = createServerSupabase();
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select(
            "id, user_id, project_id, columns_config, updated_at, active_generation_id, generation_lease_expires_at",
        )
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (isReviewGenerationRunning(review)) {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is currently running.",
        });
    }

    const mutationId = randomUUID();
    const { data: startResult, error: startError } = await db.rpc(
        "begin_tabular_review_generation",
        {
            target_review_id: reviewId,
            expected_updated_at: review.updated_at,
            target_generation_id: mutationId,
            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
        },
    );
    if (startError) return void sendInternalError(res, startError);
    if (startResult === "running") {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is currently running.",
        });
    }
    if (startResult === "stale") {
        return void res.status(409).json({
            code: "review_stale",
            detail: "A newer version of this tabular review is available.",
        });
    }
    if (startResult !== "started") {
        return void res.status(startResult === "not_found" ? 404 : 500).json({
            detail:
                startResult === "not_found"
                    ? "Review not found"
                    : "Failed to clear tabular review cells",
        });
    }

    try {
        // Async mode: reap leftover queued extraction for these rows BEFORE
        // blanking the cells. Holding the lease means no generation is live
        // (begin_ returned "started", not "running") — but a lease that LAPSED
        // can leave orphans behind: jobs still waiting in Redis that would
        // start seconds from now and re-fill the freshly cleared row, and
        // zombie jobs still running past their expired lease. Waiting/delayed
        // jobs are removed outright; a running one gets a persisted `canceled`
        // marker its next attempt no-ops on (and its terminal writes are
        // already dropped by the generation_id guards, since we clear the
        // stamp below). Best-effort — clearing must succeed even if Redis is
        // unreachable. Flag-gated so synchronous deployments never dial Redis.
        if (process.env.ASYNC_TABULAR_EXTRACTION === "true") {
            try {
                const columnIndexes = (
                    (review.columns_config as { index: number }[] | null) ?? []
                ).map((c) => c.index);
                await removeQueuedExtractionJobs(
                    reviewId,
                    row_ids,
                    columnIndexes,
                );
            } catch (err) {
                console.error(
                    "[tabular/clear-cells] queue cancellation failed",
                    err,
                );
            }
        }

        const { error } = await db
            .from("tabular_cells")
            .update({
                content: null,
                status: "pending",
                generation_id: null,
            })
            .eq("review_id", reviewId)
            .in("row_id", row_ids);
        if (error) return void sendInternalError(res, error);
        res.status(204).send();
    } finally {
        const { error } = await db.rpc("finish_tabular_review_generation", {
            target_review_id: reviewId,
            target_generation_id: mutationId,
        });
        if (error) {
            console.error(
                "[tabular/clear-cells] failed to release generation lease",
                error,
            );
        }
    }
});

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { row_id, column_index } = req.body as {
            row_id?: string;
            column_index: number;
        };

        if (!row_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "row_id and column_index are required" });

        const db = createServerSupabase();
        const { data: review, error: reviewError } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (reviewError || !review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });
        if (isReviewGenerationRunning(review)) {
            return void res.status(409).json({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
        }

        const column = (
            review.columns_config as {
                index: number;
                name: string;
                prompt: string;
                format?: string;
                tags?: string[];
            }[]
        ).find((c) => c.index === column_index);
        if (!column)
            return void res.status(400).json({ detail: "Column not found" });

        const rows = await loadReviewRows(db, reviewId);
        const row = rows.find((candidate) => candidate.id === row_id);
        if (!row)
            return void res
                .status(404)
                .json({ detail: "Review row not found" });
        const sourceIds = row.source_document_ids ?? [];
        const allowedSourceIds = await filterAccessibleDocumentIds(
            sourceIds,
            userId,
            userEmail,
            db,
        );
        if (allowedSourceIds.length !== sourceIds.length)
            return void res
                .status(404)
                .json({ detail: "Review row not found" });

        const { tabular_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        const missingKey = missingModelApiKey(tabular_model, api_keys);
        if (missingKey) {
            return void res.status(422).json({
                code: "missing_api_key",
                ...missingKey,
            });
        }

        const generationId = randomUUID();
        const { data: startResult, error: startError } = await db.rpc(
            "begin_tabular_review_generation",
            {
                target_review_id: reviewId,
                expected_updated_at: review.updated_at,
                target_generation_id: generationId,
                lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
            },
        );
        if (startError) return void sendInternalError(res, startError);
        if (startResult === "running") {
            return void res.status(409).json({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
        }
        if (startResult === "stale") {
            return void res.status(409).json({
                code: "review_stale",
                detail: "A newer version of this tabular review is available.",
            });
        }
        if (startResult !== "started") {
            return void res
                .status(startResult === "not_found" ? 404 : 500)
                .json({
                    detail:
                        startResult === "not_found"
                            ? "Review not found"
                            : "Failed to regenerate tabular review cell",
                });
        }

        let renewingLease = false;
        const leaseHeartbeat = setInterval(() => {
            if (renewingLease) return;
            renewingLease = true;
            void (async () => {
                try {
                    const { data, error } = await db.rpc(
                        "renew_tabular_review_generation",
                        {
                            target_review_id: reviewId,
                            target_generation_id: generationId,
                            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
                        },
                    );
                    if (error || data !== true) {
                        console.error(
                            "[tabular/regenerate-cell] failed to renew generation lease",
                            error ?? "Lease is no longer active",
                        );
                    }
                } catch (error) {
                    console.error(
                        "[tabular/regenerate-cell] failed to renew generation lease",
                        error,
                    );
                } finally {
                    renewingLease = false;
                }
            })();
        }, TABULAR_GENERATION_HEARTBEAT_MS);

        // Async path only: once the job is enqueued the queue owns the lease —
        // the worker renews it while it extracts and releases it through
        // `finishGenerationIfIdle` when the cell reaches a terminal state. This
        // request must then not release it on its way out, because on the 202
        // branch the job is still running.
        let leaseHandedOff = false;

        try {
            // Stamp the cell with this generation BEFORE any enqueue: the stamp
            // is what makes the worker's writes guardable and what keeps the
            // lease held until the cell is terminal.
            const { error: generatingError } = await db
                .from("tabular_cells")
                .update({
                    status: "generating",
                    content: null,
                    generation_id: generationId,
                })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index);
            if (generatingError) {
                return void sendInternalError(res, generatingError);
            }

            // Async path: enqueue a single-cell job (deduped on
            // extract:<review>:<row>:<col>, so it never collides with a
            // full-row job) and wait for the cell to reach a terminal state, so
            // the response keeps its synchronous JSON shape. The work itself is
            // durable: if this request drops or times out the worker still
            // finishes and the client catches up via the DB or the GET
            // generate/stream view.
            if (process.env.ASYNC_TABULAR_EXTRACTION === "true") {
                // The worker renews the lease from here on — two renewers would
                // only race each other.
                clearInterval(leaseHeartbeat);
                try {
                    await enqueueExtraction({
                        reviewId,
                        userId,
                        rowId: row.id,
                        columnIndex: column_index,
                        generationId,
                    });
                    leaseHandedOff = true;
                } catch (err) {
                    // Nothing will ever run this cell, so we still own both the
                    // cell's terminal state and the lease (released in finally).
                    console.error(
                        "[tabular/regenerate-cell] enqueue failed",
                        err,
                    );
                    await finalizeCell(db, {
                        reviewId,
                        rowId: row.id,
                        columnIndex: column_index,
                        status: "error",
                        generationId,
                    });
                    return void res
                        .status(500)
                        .json({ detail: "Generation failed" });
                }

                const terminal = await awaitCellTerminal({
                    db,
                    reviewId,
                    rowId: row.id,
                    columnIndex: column_index,
                    log: console,
                });
                if (terminal === null)
                    // Still running after the wait budget — the job survives
                    // this response and still holds the lease; the client keeps
                    // the cell "generating" and picks the result up from the
                    // resume stream or a reload.
                    return void res.status(202).json({
                        status: "generating",
                        detail: "Extraction still running",
                    });
                if (terminal.status === "error")
                    return void res
                        .status(500)
                        .json({ detail: "Generation failed" });
                return void res.json(terminal.content);
            }

            const markdown = await loadRowDocumentText(db, row);
            const result = await queryTabularCell(
                tabular_model,
                row.label,
                markdown,
                column.prompt,
                column.format,
                column.tags,
                api_keys,
            );

            if (!result) {
                await db
                    .from("tabular_cells")
                    .update({ status: "error", generation_id: null })
                    .eq("review_id", reviewId)
                    .eq("row_id", row.id)
                    .eq("column_index", column_index)
                    .eq("generation_id", generationId);
                return void res
                    .status(500)
                    .json({ detail: "Generation failed" });
            }

            const { error: completedError } = await db
                .from("tabular_cells")
                .update({
                    content: JSON.stringify(result),
                    status: "done",
                    generation_id: null,
                })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index)
                .eq("generation_id", generationId);
            if (completedError) {
                return void sendInternalError(res, completedError);
            }

            res.json(result);
        } catch (error) {
            await db
                .from("tabular_cells")
                .update({ status: "error", generation_id: null })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index)
                .eq("generation_id", generationId);
            console.error(
                "[tabular/regenerate-cell] generation failed",
                error,
            );
            if (!res.headersSent) {
                res.status(500).json({ detail: "Generation failed" });
            }
        } finally {
            clearInterval(leaseHeartbeat);
            // On the async path the lease now belongs to the worker running the
            // enqueued job — including on the 202 branch, where the job is
            // still going after this response. It releases it itself once the
            // cell is terminal (`finishGenerationIfIdle`).
            if (!leaseHandedOff) {
                const { error } = await db.rpc(
                    "finish_tabular_review_generation",
                    {
                        target_review_id: reviewId,
                        target_generation_id: generationId,
                    },
                );
                if (error) {
                    console.error(
                        "[tabular/regenerate-cell] failed to release generation lease",
                        error,
                    );
                }
            }
        }
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
    let renewingLease = false;
    req.on("aborted", () => generationAbort.abort());

    // Pre-lease guards only (review, access, columns, model key). Row and cell
    // state is deliberately NOT read here — see the note at the lease claim.
    const prepared = await prepareTabularGenerate(db, {
        reviewId,
        userId,
        userEmail,
    });
    if (!prepared.ok) {
        if (prepared.kind === "not_found")
            return void res.status(404).json({ detail: "Review not found" });
        if (prepared.kind === "no_columns")
            return void res
                .status(400)
                .json({ detail: "No columns configured" });
        return void res.status(422).json({
            code: "missing_api_key",
            ...prepared.missingKey,
        });
    }
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

    const { data: startResult, error: startError } = await db.rpc(
        "begin_tabular_review_generation",
        {
            target_review_id: reviewId,
            expected_updated_at: expectedUpdatedAt,
            target_generation_id: generationId,
            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
        },
    );
    if (startError) {
        return void sendInternalError(res, startError);
    }
    if (startResult === "running") {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is already running elsewhere.",
        });
    }
    if (startResult === "stale") {
        return void res.status(409).json({
            code: "review_stale",
            detail: "A newer version of this tabular review is available.",
        });
    }
    if (startResult === "not_found") {
        return void res.status(404).json({ detail: "Review not found" });
    }
    if (startResult !== "started") {
        return void res.status(500).json({
            detail: "Failed to start tabular review generation",
        });
    }
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
        leaseHeartbeat = setInterval(() => {
            if (renewingLease || generationAbort.signal.aborted) return;
            renewingLease = true;
            void (async () => {
                try {
                    const { data, error } = await db.rpc(
                        "renew_tabular_review_generation",
                        {
                            target_review_id: reviewId,
                            target_generation_id: generationId,
                            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
                        },
                    );
                    if (error || data !== true) generationAbort.abort();
                } catch {
                    generationAbort.abort();
                } finally {
                    renewingLease = false;
                }
            })();
        }, TABULAR_GENERATION_HEARTBEAT_MS);

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

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        let nextRowIndex = 0;
        const cellFrame = (
            rowId: string,
            columnIndex: number,
            content: unknown,
            status: "generating" | "done" | "error" | "pending",
        ): void => {
            write(
                `data: ${JSON.stringify({ type: "cell_update", row_id: rowId, column_index: columnIndex, content, status })}\n\n`,
            );
        };

        const processRow = async (row: ReviewRow) => {
            const existingByColumn = new Map<number, Record<string, unknown>>();
            for (const col of columns) {
                const cell = cellMap.get(`${row.id}:${col.index}`);
                if (cell) existingByColumn.set(col.index, cell);
            }

            // Shared extraction core — the async worker runs this same
            // function. It owns the generating/done DB writes (stamped with and
            // guarded by this run's generation id) and announces each
            // transition through the sink, which here writes SSE frames. It
            // never decides the terminal state of a column the model skipped;
            // it reports those in `missing`.
            const { missing } = await extractRowColumns({
                db,
                reviewId,
                row,
                columns,
                existingByColumn,
                model: tabular_model,
                apiKeys: api_keys,
                generationId,
                abortSignal: generationAbort.signal,
                sink: {
                    generating: (rowId, columnIndex) =>
                        cellFrame(rowId, columnIndex, null, "generating"),
                    done: (rowId, columnIndex, result) =>
                        cellFrame(rowId, columnIndex, result, "done"),
                },
            });

            // Stopped cells return to pending; genuine missing model output is
            // still an error. Completed cells remain untouched.
            const incompleteStatus = generationAbort.signal.aborted
                ? "pending"
                : "error";
            for (const columnIndex of missing) {
                await finalizeCell(db, {
                    reviewId,
                    rowId: row.id,
                    columnIndex,
                    status: incompleteStatus,
                    generationId,
                });
                cellFrame(row.id, columnIndex, null, incompleteStatus);
            }
        };

        const runWorker = async () => {
            while (!generationAbort.signal.aborted) {
                const rowIndex = nextRowIndex++;
                if (rowIndex >= rows.length) return;
                await processRow(rows[rowIndex]);
            }
        };
        await Promise.all(
            Array.from(
                {
                    length: Math.min(
                        TABULAR_GENERATION_CONCURRENCY,
                        rows.length,
                    ),
                },
                () => runWorker(),
            ),
        );

        if (!generationAbort.signal.aborted) {
            void recordAudit(db, {
                userId,
                userEmail,
                action: "tabular.generated",
                surface: "tabular",
                reviewId,
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
            try {
                const { error } = await db.rpc(
                    "finish_tabular_review_generation",
                    {
                        target_review_id: reviewId,
                        target_generation_id: generationId,
                    },
                );
                if (error) throw error;
            } catch (error) {
                console.error(
                    "[tabular/generate] failed to release generation lease",
                    error,
                );
            }
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
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const db = createServerSupabase();

        const prepared = await prepareTabularGenerate(db, {
            reviewId,
            userId,
            userEmail,
        });
        if (!prepared.ok) {
            if (prepared.kind === "not_found")
                return void res
                    .status(404)
                    .json({ detail: "Review not found" });
            if (prepared.kind === "no_columns")
                return void res
                    .status(400)
                    .json({ detail: "No columns configured" });
            return void res.status(422).json({
                code: "missing_api_key",
                ...prepared.missingKey,
            });
        }

        const work = await loadTabularGenerateWork(db, {
            reviewId,
            userId,
            userEmail,
        });
        if (!work.ok) return void sendInternalError(res, work.error);

        await streamTabularRunView({
            res,
            db,
            reviewId,
            columns: prepared.data.columns,
            rows: work.data.rows,
            cellMap: work.data.cellMap,
            log: console,
        });
    },
);

// GET /tabular-review/:reviewId/chats — list chats (metadata only, no messages)
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    // Verify access (owner or shared-project member).
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Show every member's chats for the review (collaborative), not just
    // the requester's. Per-chat access is gated above by review access.
    const { data: chats } = await db
        .from("tabular_review_chats")
        .select("id, title, created_at, updated_at, user_id")
        .eq("review_id", reviewId)
        .order("updated_at", { ascending: false });

    res.json(chats ?? []);
});

// DELETE /tabular-review/:reviewId/chats/:chatId — delete a single chat
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        const db = createServerSupabase();
        // Owner-only delete — sibling collaborators shouldn't be able to wipe
        // each other's threads. Selecting the deleted ids back distinguishes
        // "not yours / not there" from a real delete, which a bare 204 hid.
        const { data: deleted, error } = await db
            .from("tabular_review_chats")
            .delete()
            .eq("id", chatId)
            .eq("user_id", userId)
            .select("id");
        if (error) return void sendInternalError(res, error);
        if (!deleted || deleted.length === 0)
            return void res.status(404).json({ detail: "Chat not found" });
        res.status(204).send();
    },
);

// PATCH /tabular-review/:reviewId/chats/:chatId — rename a chat
tabularRouter.patch(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        const title =
            typeof req.body?.title === "string" ? req.body.title.trim() : "";
        if (!title)
            return void res.status(400).json({ detail: "Title is required" });
        const db = createServerSupabase();
        // Owner-only rename — mirrors the delete rule above, including
        // reporting 404 when the update matched no row.
        const { data: renamed, error } = await db
            .from("tabular_review_chats")
            .update({ title: title.slice(0, 200) })
            .eq("id", chatId)
            .eq("user_id", userId)
            .select("id");
        if (error) return void sendInternalError(res, error);
        if (!renamed || renamed.length === 0)
            return void res.status(404).json({ detail: "Chat not found" });
        res.status(204).send();
    },
);

// GET /tabular-review/:reviewId/chats/:chatId/messages — messages for a single chat
tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        const db = createServerSupabase();

        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, project_id")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const { data: chat, error: chatError } = await db
            .from("tabular_review_chats")
            .select("id, review_id")
            .eq("id", chatId)
            .single();
        if (chatError || !chat || chat.review_id !== reviewId)
            return void res.status(404).json({ detail: "Chat not found" });

        const { data: messages } = await db
            .from("tabular_review_chat_messages")
            .select("id, role, content, annotations, created_at")
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });

        res.json(messages ?? []);
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
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        review_title?: string;
        project_name?: string;
    };

    const lastUser = [...(messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
    if (!lastUser?.content?.trim()) {
        return void res
            .status(400)
            .json({ detail: "messages must include a user message" });
    }

    const db = createServerSupabase();
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const reviewAccess = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
    );
    if (!reviewAccess.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Fetch all cells and logical review rows for this review.
    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const rows = await loadReviewRows(db, reviewId);

    const sortedColumns = (
        (review.columns_config ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        columns: sortedColumns,
        documents: rows.map((row) => ({
            id: row.id,
            filename: row.label,
        })),
        cells: new Map(
            (cells ?? []).map((c: any) => [
                `${c.column_index}:${c.row_id}`,
                parseCellContent(c.content),
            ]),
        ),
    };

    // One settings load for the whole request: the title generation below
    // used to repeat this query just for `title_model`.
    const { tabular_model, title_model, api_keys } = await getUserModelSettings(
        userId,
        db,
    );
    const missingKey = missingModelApiKey(tabular_model, api_keys);
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    // Create or verify chat record
    let chatId = existingChatId ?? null;
    let chatTitle: string | null = null;
    const isFirstExchange =
        messages.filter((m) => m.role === "user").length === 1;

    if (chatId) {
        // The chat must belong to this exact review and to the requester.
        // Review access alone is not enough: otherwise a user could reuse one
        // of their chats from a different review in this route.
        const { data: existing } = await db
            .from("tabular_review_chats")
            .select("id, title, review_id, user_id")
            .eq("id", chatId)
            .single();
        const canUse =
            !!existing &&
            existing.review_id === reviewId &&
            existing.user_id === userId;
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        const { data: newChat } = await db
            .from("tabular_review_chats")
            .insert({ review_id: reviewId, user_id: userId })
            .select("id, title")
            .single();
        chatId = newChat?.id ?? null;
        chatTitle = newChat?.title ?? null;
    }

    // Persist user message
    if (chatId) {
        await db.from("tabular_review_chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
        });
    }

    const apiMessages = buildTabularMessages(
        messages,
        tabularStore,
        review.title || "Untitled Review",
    );

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
            model: tabular_model,
            apiKeys: api_keys,
            signal: streamAbort.signal,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            await db.from("tabular_review_chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: persistedEvents.length ? persistedEvents : null,
                annotations: annotations.length ? annotations : null,
            });
            await db
                .from("tabular_review_chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId);
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const title = await generateChatTitle(
                title_model,
                lastUser.content,
                {
                    reviewTitle: clientReviewTitle ?? review.title ?? null,
                    projectName: clientProjectName ?? null,
                },
                api_keys,
            );
            if (title) {
                await db
                    .from("tabular_review_chats")
                    .update({ title })
                    .eq("id", chatId);
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
                const annotations = partial.citations;
                const { error: saveError } = await db
                    .from("tabular_review_chat_messages")
                    .insert({
                        chat_id: chatId,
                        role: "assistant",
                        content: partial.events.length ? partial.events : null,
                        annotations: annotations.length ? annotations : null,
                    });
                if (saveError) {
                    console.error(
                        "[tabular/chat] failed to save aborted stream",
                        saveError,
                    );
                }
                await db
                    .from("tabular_review_chats")
                    .update({ updated_at: new Date().toISOString() })
                    .eq("id", chatId);
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
                const annotations = extractTabularAnnotations(
                    errorFullText,
                    tabularStore,
                );
                const { error: saveError } = await db
                    .from("tabular_review_chat_messages")
                    .insert({
                        chat_id: chatId,
                        role: "assistant",
                        content: errorEvents.length ? errorEvents : null,
                        annotations: annotations.length ? annotations : null,
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
