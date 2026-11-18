import { randomUUID } from "node:crypto";
import { selectInBatches } from "../../lib/batchedQuery";
import { loadReviewCells } from "./tabular.rows";
import type { Db } from "./tabular.shared";

type Cell = Record<string, unknown> & {
    id: string;
    row_id: string;
    cache_revision: string;
};
type Snapshot = {
    db: Db;
    userId: string;
    reviewId: string;
    revisions: Map<string, string>;
};
// Keep identifiers only. A different replica, an evicted token, or an oversized
// grid uses the ordinary full-detail response.
const snapshots = new Map<string, Snapshot>();
const maxTrackedCells = 100_000;
let trackedCells = 0;

function remember(snapshot: Snapshot): string | undefined {
    if (snapshot.revisions.size > maxTrackedCells) return;
    while (snapshots.size >= 64 || trackedCells + snapshot.revisions.size > maxTrackedCells) {
        const oldest = snapshots.entries().next();
        if (oldest.done) break;
        trackedCells -= oldest.value[1].revisions.size;
        snapshots.delete(oldest.value[0]);
    }
    const token = randomUUID();
    snapshots.set(token, snapshot);
    trackedCells += snapshot.revisions.size;
    return token;
}

export async function reviewCellSnapshot(
    db: Db,
    reviewId: string,
    userId: string,
    visible: Set<string>,
    token?: string,
) {
    const previous = token ? snapshots.get(token) : undefined;
    const delta = previous?.db === db && previous.reviewId === reviewId && previous.userId === userId;
    const records = (await loadReviewCells<Cell>(db, reviewId, delta ? "id,row_id,cache_revision" : "*"))
        .filter(cell => visible.has(cell.row_id));
    const revisions = new Map(records.map(cell => [cell.id, cell.cache_revision]));
    let cells = records;
    if (delta) {
        const changed = records.filter(cell => previous.revisions.get(cell.id) !== cell.cache_revision);
        cells = await selectInBatches<Cell>(
            "changed review cells",
            changed.map(cell => cell.id),
            batch => db.from("tabular_cells").select("*").eq("review_id", reviewId).in("id", batch),
        );
        // Deletions or moves between the manifest and body reads must not
        // leave a phantom revision or expose a row outside the authorized set.
        for (const cell of changed) revisions.delete(cell.id);
        cells = cells.filter(cell => visible.has(cell.row_id));
        for (const cell of cells) revisions.set(cell.id, cell.cache_revision);
    }
    const valid = records.every(cell => typeof cell.cache_revision === "string");
    return {
        cells,
        cell_revision: valid ? remember({ db, userId, reviewId, revisions }) : undefined,
        ...(delta && { removed_cell_ids: [...previous.revisions.keys()].filter(id => !revisions.has(id)) }),
    };
}
