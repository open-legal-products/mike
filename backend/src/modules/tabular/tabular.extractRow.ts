// The single source of truth for extracting one row's cells.
//
// A row is the review grid's unit of work: one document, or a folder of source
// documents whose combined text is extracted together. Both entry points
// delegate here so the extraction loop lives in exactly one place:
//   - the synchronous SSE route (POST /:reviewId/generate) — sink writes SSE
//     frames; the caller finalizes any `missing` columns inline.
//   - the async worker (workers/extractionWorker.ts) — sink publishes over
//     Redis; the caller throws on `missing` so BullMQ retries.
//
// This function owns the DB writes (mark generating, persist done) and the
// row-text loading + single multi-column LLM call. It does NOT decide the
// terminal policy for columns the model failed to return — it reports them via
// `missing` and lets each caller apply its own policy (the sync route resets
// them to "pending" when the run was stopped and "error" otherwise).
//
// GENERATION ISOLATION: every write here is stamped with the caller's
// `generationId` and guarded by it (`.eq("generation_id", generationId)`) —
// the mark-generating write as much as the terminal one, because marking also
// clears `content`. A run whose lease was taken over can therefore never
// clobber the winner's results: its updates simply match no rows. This relies
// on the caller having CLAIMED its cells (stamped generation_id on each one)
// before calling in — `claimCellsForGeneration` in tabular.generateStream.ts,
// used by both the sync and async entry points. See tabular.shared.ts for the
// lease itself.

import { type UserApiKeys } from "../../lib/llm";
import { queryTabularAllColumns } from "./tabular.extract";
import { loadRowDocumentText, type ReviewRow } from "./tabular.rows";
import { type CellResult, type Column, type Db } from "./tabular.shared";

/**
 * Where per-cell transitions are announced. Sync uses this to write SSE frames;
 * async uses it to publish over Redis. Both `generating` and `done` mirror the
 * DB writes this module performs around them.
 */
export interface CellSink {
    generating(rowId: string, columnIndex: number): void | Promise<void>;
    done(
        rowId: string,
        columnIndex: number,
        result: CellResult,
    ): void | Promise<void>;
}

export interface ExtractRowResult {
    /** Columns that were not already done and so were (re)processed. */
    processed: Column[];
    /** Columns the model returned a result for. */
    received: Set<number>;
    /** Processed columns the model did NOT return — caller decides the policy. */
    missing: number[];
}

/**
 * Write a terminal, non-`done` state for one cell ("error", or "pending" when a
 * run was stopped). Clears the generation stamp and — when a generation is in
 * play — only touches a cell this generation still owns.
 */
export async function finalizeCell(
    db: Db,
    args: {
        reviewId: string;
        rowId: string;
        columnIndex: number;
        status: "pending" | "error";
        generationId?: string | null;
    },
): Promise<void> {
    const query = db
        .from("tabular_cells")
        .update({
            status: args.status,
            content: null,
            generation_id: null,
        })
        .eq("review_id", args.reviewId)
        .eq("row_id", args.rowId)
        .eq("column_index", args.columnIndex);
    await (args.generationId
        ? query.eq("generation_id", args.generationId)
        : query);
}

/**
 * Extract every not-yet-`done` column for one row.
 *
 * Idempotent: columns already `done` with content are skipped, so a re-run only
 * touches outstanding columns. `queryTabularAllColumns` swallows its own LLM/
 * stream errors (surfacing them as unreturned columns), so this function does
 * not throw on model failure — it reports `missing` instead.
 *
 * `abortSignal` stops the run. Aborting BEFORE any cell has been marked
 * "generating" leaves the grid exactly as it was found (nothing processed,
 * nothing missing); aborting mid-stream reports the unreturned columns as
 * `missing` so the caller can reset them.
 */
export async function extractRowColumns(args: {
    db: Db;
    reviewId: string;
    row: ReviewRow;
    columns: Column[];
    /** Current cell records for THIS row, keyed by column index. */
    existingByColumn: Map<number, Record<string, unknown>>;
    model: string;
    apiKeys: UserApiKeys;
    sink: CellSink;
    /** Generation this run belongs to; stamps and guards every cell write. */
    generationId?: string | null;
    /** Stops the run (client disconnect, or lease lost). */
    abortSignal?: AbortSignal;
}): Promise<ExtractRowResult> {
    const {
        db,
        reviewId,
        row,
        columns,
        existingByColumn,
        model,
        apiKeys,
        sink,
        generationId,
        abortSignal,
    } = args;

    const processed = columns.filter((col) => {
        const cell = existingByColumn.get(col.index);
        return !(cell?.status === "done" && cell?.content);
    });
    const untouched = (): ExtractRowResult => ({
        processed,
        received: new Set<number>(),
        missing: [],
    });
    if (processed.length === 0) return untouched();
    if (abortSignal?.aborted) return untouched();

    // Load the row's combined source-document text once (each section is
    // prefixed with its source document id so citations can name it). Loaded
    // before anything is marked "generating" so a run stopped during the (slow)
    // download leaves the grid exactly as it found it.
    const markdown = await loadRowDocumentText(db, row);
    if (abortSignal?.aborted) return untouched();

    // Mark each outstanding column "generating" (insert the cell if it's new)
    // and announce it, so the grid shows spinners immediately.
    //
    // GUARDED, exactly like the terminal write below. This write clears
    // `content`, so an unguarded version is the one place a superseded run can
    // still destroy the winner's results: a stale run whose snapshot said
    // "pending" re-stamps the cell with its OWN generation id, blanking a
    // result the live generation had already written — and having re-stamped
    // it, its later `.eq("generation_id", generationId)` terminal write now
    // MATCHES and writes the stale answer over the fresh one. Both callers
    // claim their cells (stamping generation_id) before extraction begins, so
    // for a run that still owns its cells this matches, and for one that has
    // been superseded it matches nothing.
    for (const col of processed) {
        await sink.generating(row.id, col.index);
        const existing = existingByColumn.get(col.index);
        if (existing?.id) {
            const markQuery = db
                .from("tabular_cells")
                .update({
                    status: "generating",
                    content: null,
                    generation_id: generationId ?? null,
                })
                .eq("id", existing.id);
            await (generationId
                ? markQuery.eq("generation_id", generationId)
                : markQuery);
        } else {
            await db.from("tabular_cells").insert({
                review_id: reviewId,
                row_id: row.id,
                document_id: row.document_id,
                column_index: col.index,
                status: "generating",
                generation_id: generationId ?? null,
            });
        }
    }

    // One LLM call for all outstanding columns; persist + announce each result.
    const received = new Set<number>();
    try {
        await queryTabularAllColumns(
            model,
            row.label,
            markdown,
            processed,
            async (columnIndex, result) => {
                received.add(columnIndex);
                const query = db
                    .from("tabular_cells")
                    .update({
                        content: JSON.stringify(result),
                        status: "done",
                        generation_id: null,
                    })
                    .eq("review_id", reviewId)
                    .eq("row_id", row.id)
                    .eq("column_index", columnIndex);
                await (generationId
                    ? query.eq("generation_id", generationId)
                    : query);
                await sink.done(row.id, columnIndex, result);
            },
            apiKeys,
            abortSignal,
        );
    } catch (err) {
        // An abort re-thrown by the stream is the caller stopping us, not a
        // failure worth logging; the unreturned columns are reported below.
        if (!abortSignal?.aborted) {
            console.error(
                `[tabular/extract-row] queryTabularAllColumns error row=${row.id}`,
                err,
            );
        }
    }

    const missing = processed
        .filter((c) => !received.has(c.index))
        .map((c) => c.index);
    return { processed, received, missing };
}
