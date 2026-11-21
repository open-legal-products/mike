import { beforeEach, expect, it, vi } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { conversionJobId } from "../../../lib/queue/conversionQueue";

const queue = vi.hoisted(() => ({ live: new Set<string>() }));
vi.mock("../../../lib/dbq/driver", () => ({ redisEnabled: () => false }));
vi.mock("../../../lib/dbq/enqueue", () => ({
    liveDbJobDedupeKeys: vi.fn(async (_db: unknown, keys: string[]) =>
        keys.filter((key) => queue.live.has(key)),
    ),
}));

// The sweep's resume point is module state: each test starts a fresh pass.
let sweep: typeof import("../documents.maintenance").sweepStaleProcessingDocuments;
beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("ASYNC_DOCUMENT_CONVERSION", "true");
    queue.live.clear();
    ({ sweepStaleProcessingDocuments: sweep } = await import("../documents.maintenance.js"));
});

const OLD = "2020-01-01T00:00:00Z";
/** A stale processing document whose conversion job is still queued. */
function liveDoc(id: string, updated_at = OLD) {
    queue.live.add(conversionJobId(`v-${id}`, `${id}.docx`));
    return { id, status: "processing", current_version_id: `v-${id}`, updated_at };
}
const orphan = (id: string, updated_at = OLD) =>
    ({ id, status: "processing", current_version_id: null, updated_at });
const versionsOf = (docs: { id: string; current_version_id: string | null }[]) =>
    docs.filter((d) => d.current_version_id).map((d) => ({ id: d.current_version_id, storage_path: `${d.id}.docx` }));
const statusOf = (fake: ReturnType<typeof tableDb>, id: string) =>
    fake.tables.documents.find((d) => d.id === id)?.status;

it("reaches an orphan behind a full page of live conversions within one pass", async () => {
    const live = Array.from({ length: 500 }, (_, i) => liveDoc(`a${String(i).padStart(3, "0")}`));
    const docs = [...live, orphan("b-orphan", "2020-01-02T00:00:00Z")];
    const fake = tableDb({ documents: docs, document_versions: versionsOf(docs) }, { maxInList: 1000 });

    for (let i = 0; i < 2; i++) await sweep(fake.db);

    expect(statusOf(fake, "b-orphan")).toBe("error");
    expect(fake.tables.documents.filter((d) => d.status === "processing")).toHaveLength(500);
});

it("visits every candidate across pages with equal timestamps, then wraps around", async () => {
    // 1,100 live documents with ONE shared updated_at, orphans in every page.
    const docs = Array.from({ length: 1100 }, (_, i) => {
        const id = `d${String(i).padStart(4, "0")}`;
        return i % 500 === 7 ? orphan(id) : liveDoc(id);
    });
    const fake = tableDb({ documents: docs, document_versions: versionsOf(docs) }, { maxInList: 1000 });
    const pageReads = () => fake.calls.filter((c) => c.table === "documents" && c.op === "select");

    expect(await sweep(fake.db)).toBe(1); // d0007
    expect(await sweep(fake.db)).toBe(1); // d0507
    expect(await sweep(fake.db)).toBe(1); // d1007
    // Every read stayed within the sweep's budget.
    expect(pageReads().every((c) => c.returned <= 500)).toBe(true);

    // A job that ends mid-pass (an id the pass already went by) is found on
    // the wrap-around, not never.
    queue.live.delete(conversionJobId("v-d0001", "d0001.docx"));
    expect(await sweep(fake.db)).toBe(1);
    expect(statusOf(fake, "d0001")).toBe("error");
});
