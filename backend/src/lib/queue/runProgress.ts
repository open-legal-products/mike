import type { AssistantErrorCode } from "@mike/contracts";
import { getRedisProducerConnection, withRedisTimeout } from "./connection";
import { redisEnabled } from "../dbq/driver";

/**
 * Redis pub/sub bridge between the extraction worker and the SSE request that a
 * client is tailing. The worker publishes per-cell progress; the /generate
 * stream subscribes and forwards those frames to the browser.
 *
 * The DB (`tabular_cells`) is the source of truth — pub/sub is only the
 * low-latency delivery path. The stream handler additionally reconciles against
 * the DB on an interval, so a dropped message never leaves a stream hung.
 */

/** Channel a given review's extraction progress is published on. */
export function runProgressChannel(reviewId: string): string {
    return `tabular-run:${reviewId}`;
}

/** One progress frame — the same shape the SSE `cell_update` event carries. */
export interface CellUpdate {
    type: "cell_update";
    row_id: string;
    column_index: number;
    content: unknown;
    status: "generating" | "done" | "error";
}

export interface GenerationErrorUpdate {
    type: "error";
    message: string;
    safe_to_display?: true;
    code?: AssistantErrorCode;
}

export type RunProgressUpdate = CellUpdate | GenerationErrorUpdate;

/**
 * Publish one cell update for a review. Best-effort: a publish failure must not
 * fail the extraction (the DB write is what matters), so errors are swallowed.
 * PUBLISH is an ordinary Redis command, so it safely shares the BullMQ
 * connection (which is never put into subscriber mode).
 */
export async function publishCellUpdate(
    reviewId: string,
    update: RunProgressUpdate,
): Promise<void> {
    // Postgres driver: no pub/sub channel exists — the tailing views resolve
    // every cell through their DB-poll backstops, so silently skipping the
    // publish is correct, and dialing Redis here would hang no-Redis deploys.
    if (!redisEnabled()) return;
    try {
        await withRedisTimeout("progress publish", () =>
            getRedisProducerConnection().publish(
                runProgressChannel(reviewId),
                JSON.stringify(update),
            ),
        );
    } catch {
        // Non-fatal: the worker has already persisted the cell; the tailing
        // stream's DB-poll backstop will pick the state change up.
    }
}
