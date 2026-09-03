// Cell-level services for the tabular module: clearing a set of rows back to
// pending, and regenerating one cell.
//
// Both operations mutate cells while a generation could be racing them, so
// both take the review's generation lease for their whole duration — the same
// lease the generate stream takes (see the note in tabular.shared.ts). That is
// why they live behind a service rather than in the route: the lease claim, the
// heartbeat that keeps it alive, the queue hand-off and the guarded terminal
// writes are one indivisible piece of behavior, and none of it needs `res`.

import { randomUUID } from "node:crypto";
import {
    ensureReviewAccess,
    filterAccessibleDocumentIds,
} from "../../lib/access";
import { failure, internalFailure } from "../../lib/serviceResult";
import {
    enqueueExtraction,
    removeQueuedExtractionJobs,
} from "../../lib/queue/extractionQueue";
import { queryTabularCell } from "./tabular.extract";
import { finalizeCell } from "./tabular.extractRow";
import { awaitCellTerminal } from "./tabular.generateStream";
import { loadReviewRows, loadRowDocumentText } from "./tabular.rows";
import {
    isReviewGenerationRunning,
    modelFailure,
    statusFailure,
    validateSelectedModel,
    TABULAR_GENERATION_HEARTBEAT_MS,
    TABULAR_GENERATION_LEASE_SECONDS,
    type Db,
    type Log,
    type TabularResult,
} from "./tabular.shared";

/** The 409/404/500 answers `begin_tabular_review_generation` can produce. */
const RUNNING_CONFLICT = failure(
    "conflict",
    "This tabular review is currently running.",
    "review_running",
);
const STALE_CONFLICT = failure(
    "conflict",
    "A newer version of this tabular review is available.",
    "review_stale",
);

// ---------------------------------------------------------------------------
// POST /:reviewId/clear-cells
// ---------------------------------------------------------------------------

/**
 * Reset cells to an empty/pending state for the given row ids. Does not delete
 * the rows — it blanks `content` and sets `status` back to "pending".
 */
export async function clearTabularReviewCells(
    db: Db,
    args: {
        reviewId: string;
        userId: string;
        userEmail: string | undefined;
        rowIds: string[];
        log: Log;
    },
): Promise<TabularResult<null>> {
    const { reviewId, userId, userEmail, rowIds, log } = args;

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select(
            "id, user_id, project_id, columns_config, updated_at, active_generation_id, generation_lease_expires_at",
        )
        .eq("id", reviewId)
        .single();
    if (reviewError || !review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Review not found");
    if (isReviewGenerationRunning(review)) return RUNNING_CONFLICT;

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
    if (startError) return internalFailure(startError);
    if (startResult === "running") return RUNNING_CONFLICT;
    if (startResult === "stale") return STALE_CONFLICT;
    if (startResult !== "started") {
        return startResult === "not_found"
            ? failure("not_found", "Review not found")
            : statusFailure(500, {
                  detail: "Failed to clear tabular review cells",
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
                    rowIds,
                    columnIndexes,
                );
            } catch (err) {
                log.error("[tabular/clear-cells] queue cancellation failed", err);
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
            .in("row_id", rowIds);
        if (error) return internalFailure(error);
        return { ok: true, data: null };
    } finally {
        const { error } = await db.rpc("finish_tabular_review_generation", {
            target_review_id: reviewId,
            target_generation_id: mutationId,
        });
        if (error) {
            log.error(
                "[tabular/clear-cells] failed to release generation lease",
                error,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// POST /:reviewId/regenerate-cell
// ---------------------------------------------------------------------------

/**
 * The response a successful regenerate produces: the finished cell content
 * (200), or an acknowledgement that the queued job outlived the wait budget
 * and the client should pick the result up from the resume stream (202).
 */
export type RegenerateCellOutcome =
    | { status: 200; body: unknown }
    | { status: 202; body: { status: string; detail: string } };

const GENERATION_FAILED = statusFailure(500, { detail: "Generation failed" });

export async function regenerateTabularCell(
    db: Db,
    args: {
        reviewId: string;
        userId: string;
        userEmail: string | undefined;
        rowId: string;
        columnIndex: number;
        log: Log;
    },
): Promise<TabularResult<RegenerateCellOutcome>> {
    const { reviewId, userId, userEmail, rowId, columnIndex, log } = args;

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Review not found");
    if (isReviewGenerationRunning(review)) return RUNNING_CONFLICT;

    const column = (
        review.columns_config as {
            index: number;
            name: string;
            prompt: string;
            format?: string;
            tags?: string[];
        }[]
    ).find((c) => c.index === columnIndex);
    if (!column) return failure("validation", "Column not found");

    const rows = await loadReviewRows(db, reviewId);
    const row = rows.find((candidate) => candidate.id === rowId);
    if (!row) return failure("not_found", "Review row not found");
    const sourceIds = row.source_document_ids ?? [];
    const allowedSourceIds = await filterAccessibleDocumentIds(
        sourceIds,
        userId,
        userEmail,
        db,
    );
    if (allowedSourceIds.length !== sourceIds.length)
        return failure("not_found", "Review row not found");

    const selectedModel = await validateSelectedModel(review.model, userId, db);
    if (!selectedModel.ok) return modelFailure(selectedModel);
    const tabular_model = selectedModel.model;
    const api_keys = selectedModel.apiKeys;

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
    if (startError) return internalFailure(startError);
    if (startResult === "running") return RUNNING_CONFLICT;
    if (startResult === "stale") return STALE_CONFLICT;
    if (startResult !== "started") {
        return startResult === "not_found"
            ? failure("not_found", "Review not found")
            : statusFailure(500, {
                  detail: "Failed to regenerate tabular review cell",
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
                    log.error(
                        "[tabular/regenerate-cell] failed to renew generation lease",
                        error ?? "Lease is no longer active",
                    );
                }
            } catch (error) {
                log.error(
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
            .eq("column_index", columnIndex);
        if (generatingError) return internalFailure(generatingError);

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
                    columnIndex,
                    generationId,
                });
                leaseHandedOff = true;
            } catch (err) {
                // Nothing will ever run this cell, so we still own both the
                // cell's terminal state and the lease (released in finally).
                log.error("[tabular/regenerate-cell] enqueue failed", err);
                await finalizeCell(db, {
                    reviewId,
                    rowId: row.id,
                    columnIndex,
                    status: "error",
                    generationId,
                });
                return GENERATION_FAILED;
            }

            const terminal = await awaitCellTerminal({
                db,
                reviewId,
                rowId: row.id,
                columnIndex,
                log,
            });
            if (terminal === null)
                // Still running after the wait budget — the job survives
                // this response and still holds the lease; the client keeps
                // the cell "generating" and picks the result up from the
                // resume stream or a reload.
                return {
                    ok: true,
                    data: {
                        status: 202,
                        body: {
                            status: "generating",
                            detail: "Extraction still running",
                        },
                    },
                };
            if (terminal.status === "error") return GENERATION_FAILED;
            return { ok: true, data: { status: 200, body: terminal.content } };
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
                .eq("column_index", columnIndex)
                .eq("generation_id", generationId);
            return GENERATION_FAILED;
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
            .eq("column_index", columnIndex)
            .eq("generation_id", generationId);
        if (completedError) return internalFailure(completedError);

        return { ok: true, data: { status: 200, body: result } };
    } catch (error) {
        await db
            .from("tabular_cells")
            .update({ status: "error", generation_id: null })
            .eq("review_id", reviewId)
            .eq("row_id", row.id)
            .eq("column_index", columnIndex)
            .eq("generation_id", generationId);
        log.error("[tabular/regenerate-cell] generation failed", error);
        return GENERATION_FAILED;
    } finally {
        clearInterval(leaseHeartbeat);
        // On the async path the lease now belongs to the worker running the
        // enqueued job — including on the 202 branch, where the job is
        // still going after this response. It releases it itself once the
        // cell is terminal (`finishGenerationIfIdle`).
        if (!leaseHandedOff) {
            const { error } = await db.rpc("finish_tabular_review_generation", {
                target_review_id: reviewId,
                target_generation_id: generationId,
            });
            if (error) {
                log.error(
                    "[tabular/regenerate-cell] failed to release generation lease",
                    error,
                );
            }
        }
    }
}
