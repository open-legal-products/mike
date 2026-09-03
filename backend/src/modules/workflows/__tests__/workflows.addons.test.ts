// Unit tests for the add-on catalog service functions. They drive the four
// exported functions against a fake `db` (no Supabase, no network) and assert
// the two things the HTTP layer can no longer see for itself: the exact
// filters sent to the database, and the typed result each branch returns.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  downloadFile,
  uploadFile,
  loadDocumentDisplay,
  prepareDocumentDisplay,
  enqueueStorageCleanup,
} = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  loadDocumentDisplay: vi.fn(),
  prepareDocumentDisplay: vi.fn(),
  enqueueStorageCleanup: vi.fn(),
}));

vi.mock("../../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/storage")>();
  return { ...actual, downloadFile, uploadFile };
});

vi.mock("../../../lib/documentDisplay", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/documentDisplay")>();
  // prepareDocumentDisplay is stubbed too: the real one shells out to
  // LibreOffice for a .docx, which a unit test must not do.
  return { ...actual, loadDocumentDisplay, prepareDocumentDisplay };
});

vi.mock("../../../lib/dbq/enqueue", () => ({
  enqueueStorageCleanup: (...args: unknown[]) => enqueueStorageCleanup(...args),
}));

import type { Db } from "../../../lib/supabase";
import {
  getWorkflowAddon,
  importWorkflowAddon,
  listWorkflowAddons,
  loadWorkflowAddonAssetDisplay,
} from "../workflows.addons";

type Result = { data: unknown; error: unknown };
type Call = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filters: [string, ...unknown[]][];
};

/**
 * Minimal PostgREST-shaped fake. Each table gets a queue of results; the last
 * one is reused so a repeated table (documents insert + update) needs only as
 * many entries as it has distinct answers. Every chained filter is recorded.
 */
function makeDb(results: Record<string, Result[]>) {
  const calls: Call[] = [];
  function from(table: string) {
    const call: Call = { table, op: "select", filters: [] };
    calls.push(call);
    const next = (): Result => {
      const queue = results[table];
      if (!queue || queue.length === 0) {
        throw new Error(`no result queued for table ${table}`);
      }
      return queue.length > 1 ? queue.shift()! : queue[0];
    };
    const builder: Record<string, unknown> = {
      select: (...a: unknown[]) => (call.filters.push(["select", ...a]), builder),
      insert: (payload: unknown) => ((call.op = "insert"), (call.payload = payload), builder),
      update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), builder),
      delete: () => ((call.op = "delete"), builder),
      eq: (...a: unknown[]) => (call.filters.push(["eq", ...a]), builder),
      in: (...a: unknown[]) => (call.filters.push(["in", ...a]), builder),
      order: (...a: unknown[]) => (call.filters.push(["order", ...a]), builder),
      single: async () => next(),
      maybeSingle: async () => next(),
      then: (
        resolve: (value: Result) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(next()).then(resolve, reject),
    };
    return builder;
  }
  return { db: { from } as unknown as Db, calls };
}

const filtersOf = (calls: Call[], table: string) =>
  calls.filter((c) => c.table === table).flatMap((c) => c.filters);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listWorkflowAddons", () => {
  it("returns active add-ons with workflow_key renamed and assets grouped", async () => {
    const { db, calls } = makeDb({
      mike_workflows: [
        {
          data: [
            { id: "a1", workflow_key: "draft", title: "Draft", type: "assistant" },
            { id: "a2", workflow_key: "grid", title: "Grid", type: "tabular" },
          ],
          error: null,
        },
      ],
      mike_workflow_assets: [
        {
          data: [
            {
              id: "asset-1",
              mike_workflow_id: "a1",
              filename: "Precedent.docx",
              file_type: "docx",
              size_bytes: 42,
              created_at: "2026-08-28T00:00:00.000Z",
            },
          ],
          error: null,
        },
      ],
    });

    const result = await listWorkflowAddons(db, { type: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({ id: "a1", addon_key: "draft" });
    expect(result.data[0]).not.toHaveProperty("workflow_key");
    // The join key is an implementation detail and must not reach the client.
    expect(result.data[0].assets).toEqual([
      {
        id: "asset-1",
        filename: "Precedent.docx",
        file_type: "docx",
        size_bytes: 42,
        created_at: "2026-08-28T00:00:00.000Z",
      },
    ]);
    // Tabular add-ons are never asset-joined.
    expect(result.data[1].assets).toEqual([]);
    expect(filtersOf(calls, "mike_workflows")).toContainEqual([
      "eq",
      "distribution",
      "addon",
    ]);
    expect(filtersOf(calls, "mike_workflows")).toContainEqual(["eq", "active", true]);
    expect(filtersOf(calls, "mike_workflow_assets")).toContainEqual([
      "in",
      "mike_workflow_id",
      ["a1"],
    ]);
  });

  it("applies the type filter only for assistant and tabular", async () => {
    const rows = { mike_workflows: [{ data: [], error: null }] };

    const accepted = makeDb(rows);
    await listWorkflowAddons(accepted.db, { type: "tabular" });
    expect(filtersOf(accepted.calls, "mike_workflows")).toContainEqual([
      "eq",
      "type",
      "tabular",
    ]);

    const rejected = makeDb({ mike_workflows: [{ data: [], error: null }] });
    await listWorkflowAddons(rejected.db, { type: "anything-else" });
    expect(
      filtersOf(rejected.calls, "mike_workflows").some(([, column]) => column === "type"),
    ).toBe(false);
  });

  it("skips the asset query when no assistant add-ons matched", async () => {
    const { db, calls } = makeDb({
      mike_workflows: [
        { data: [{ id: "a2", workflow_key: "grid", type: "tabular" }], error: null },
      ],
    });

    const result = await listWorkflowAddons(db, { type: "tabular" });

    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.table === "mike_workflow_assets")).toBe(false);
  });

  it("reports a catalog query error as an internal failure", async () => {
    const { db } = makeDb({
      mike_workflows: [{ data: null, error: { message: "boom" } }],
    });

    const result = await listWorkflowAddons(db, { type: null });

    expect(result).toEqual({ ok: false, kind: "error", error: { message: "boom" } });
  });
});

describe("loadWorkflowAddonAssetDisplay", () => {
  const display = {
    bytes: Buffer.from("pdf"),
    contentType: "application/pdf",
    filename: "Deck.pdf",
  };

  it("returns the display payload for an assistant add-on asset", async () => {
    loadDocumentDisplay.mockResolvedValue(display);
    const { db, calls } = makeDb({
      mike_workflows: [{ data: { id: "a1", type: "assistant" }, error: null }],
      mike_workflow_assets: [
        {
          data: {
            id: "asset-1",
            filename: "Deck.pptx",
            file_type: "pptx",
            storage_path: "mike-workflows/a1/deck.pptx",
          },
          error: null,
        },
      ],
    });

    const result = await loadWorkflowAddonAssetDisplay(db, {
      addonId: "a1",
      assetId: "asset-1",
    });

    expect(result).toEqual({ ok: true, data: display });
    expect(loadDocumentDisplay).toHaveBeenCalledWith({
      filename: "Deck.pptx",
      fileType: "pptx",
      storagePath: "mike-workflows/a1/deck.pptx",
    });
    // The asset lookup is scoped to the add-on, so a foreign asset id 404s.
    expect(filtersOf(calls, "mike_workflow_assets")).toContainEqual([
      "eq",
      "mike_workflow_id",
      "a1",
    ]);
  });

  it("404s a missing add-on and a non-assistant add-on alike", async () => {
    const missing = makeDb({ mike_workflows: [{ data: null, error: null }] });
    expect(
      await loadWorkflowAddonAssetDisplay(missing.db, { addonId: "a1", assetId: "x" }),
    ).toEqual({ ok: false, kind: "not_found", detail: "Add-on not found" });

    const tabular = makeDb({
      mike_workflows: [{ data: { id: "a2", type: "tabular" }, error: null }],
    });
    expect(
      await loadWorkflowAddonAssetDisplay(tabular.db, { addonId: "a2", assetId: "x" }),
    ).toEqual({ ok: false, kind: "not_found", detail: "Add-on not found" });
  });

  it("404s a missing asset row and a missing storage object with distinct details", async () => {
    const noRow = makeDb({
      mike_workflows: [{ data: { id: "a1", type: "assistant" }, error: null }],
      mike_workflow_assets: [{ data: null, error: null }],
    });
    expect(
      await loadWorkflowAddonAssetDisplay(noRow.db, { addonId: "a1", assetId: "x" }),
    ).toEqual({ ok: false, kind: "not_found", detail: "Asset not found" });

    loadDocumentDisplay.mockResolvedValue(null);
    const noObject = makeDb({
      mike_workflows: [{ data: { id: "a1", type: "assistant" }, error: null }],
      mike_workflow_assets: [
        { data: { id: "asset-1", filename: "a.docx", file_type: "docx", storage_path: "p" }, error: null },
      ],
    });
    expect(
      await loadWorkflowAddonAssetDisplay(noObject.db, {
        addonId: "a1",
        assetId: "asset-1",
      }),
    ).toEqual({ ok: false, kind: "not_found", detail: "Asset not found in storage" });
  });

  it("contains a conversion throw as an internal failure", async () => {
    const boom = new Error("libreoffice died");
    loadDocumentDisplay.mockRejectedValue(boom);
    const { db } = makeDb({
      mike_workflows: [{ data: { id: "a1", type: "assistant" }, error: null }],
      mike_workflow_assets: [
        { data: { id: "asset-1", filename: "a.docx", file_type: "docx", storage_path: "p" }, error: null },
      ],
    });

    expect(
      await loadWorkflowAddonAssetDisplay(db, { addonId: "a1", assetId: "asset-1" }),
    ).toEqual({ ok: false, kind: "error", error: boom });
  });
});

describe("getWorkflowAddon", () => {
  it("renames workflow_key and attaches assistant assets", async () => {
    const { db } = makeDb({
      mike_workflows: [
        { data: { id: "a1", workflow_key: "draft", type: "assistant" }, error: null },
      ],
      mike_workflow_assets: [
        { data: [{ id: "asset-1", filename: "Precedent.docx" }], error: null },
      ],
    });

    const result = await getWorkflowAddon(db, { addonId: "a1" });

    expect(result).toEqual({
      ok: true,
      data: {
        id: "a1",
        type: "assistant",
        addon_key: "draft",
        assets: [{ id: "asset-1", filename: "Precedent.docx" }],
      },
    });
  });

  it("returns an empty asset list for a tabular add-on without querying assets", async () => {
    const { db, calls } = makeDb({
      mike_workflows: [
        { data: { id: "a2", workflow_key: "grid", type: "tabular" }, error: null },
      ],
    });

    const result = await getWorkflowAddon(db, { addonId: "a2" });

    expect(result.ok && result.data.assets).toEqual([]);
    expect(calls.some((c) => c.table === "mike_workflow_assets")).toBe(false);
  });

  it("404s a missing row and a query error alike", async () => {
    const missing = makeDb({ mike_workflows: [{ data: null, error: null }] });
    expect(await getWorkflowAddon(missing.db, { addonId: "a1" })).toEqual({
      ok: false,
      kind: "not_found",
      detail: "Add-on not found",
    });

    const errored = makeDb({
      mike_workflows: [{ data: null, error: { message: "boom" } }],
    });
    expect(await getWorkflowAddon(errored.db, { addonId: "a1" })).toEqual({
      ok: false,
      kind: "not_found",
      detail: "Add-on not found",
    });
  });
});

describe("importWorkflowAddon", () => {
  const catalogRow = {
    id: "a1",
    title: "Design Partner Draft",
    type: "assistant",
    prompt_md: "Draft from the precedent.",
    columns_config: null,
    language: null,
    practice: null,
    jurisdictions: null,
  };
  const workflowRow = {
    id: "w1",
    user_id: "u1",
    title: "Design Partner Draft",
    type: "assistant",
    prompt_md: "Draft from the precedent.",
    columns_config: null,
    language: "English",
    practice: "General Transactions",
    jurisdictions: ["General"],
    created_at: "2026-08-28T00:00:00.000Z",
  };

  it("404s an add-on that is not in the active catalog", async () => {
    const { db } = makeDb({ mike_workflows: [{ data: null, error: null }] });

    expect(await importWorkflowAddon(db, { addonId: "a1", userId: "u1" })).toEqual({
      ok: false,
      kind: "not_found",
      detail: "Add-on not found",
    });
  });

  it("falls back to the catalog defaults when the row omits them", async () => {
    const { db, calls } = makeDb({
      mike_workflows: [{ data: catalogRow, error: null }],
      workflows: [{ data: workflowRow, error: null }],
      mike_workflow_assets: [{ data: [], error: null }],
    });

    const result = await importWorkflowAddon(db, { addonId: "a1", userId: "u1" });

    expect(result.ok).toBe(true);
    const insert = calls.find((c) => c.table === "workflows" && c.op === "insert");
    expect(insert?.payload).toMatchObject({
      user_id: "u1",
      language: "English",
      practice: "General Transactions",
      jurisdictions: ["General"],
    });
  });

  it("copies each asset into a document + version and returns the workflow payload", async () => {
    downloadFile.mockResolvedValue(new TextEncoder().encode("reference").buffer);
    uploadFile.mockResolvedValue(undefined);
    prepareDocumentDisplay.mockResolvedValue({
      bytes: Buffer.from("converted-pdf"),
      contentType: "application/pdf",
      filename: "Precedent.pdf",
    });
    const { db, calls } = makeDb({
      mike_workflows: [{ data: catalogRow, error: null }],
      workflows: [{ data: workflowRow, error: null }],
      mike_workflow_assets: [
        {
          data: [
            {
              filename: "Precedent.docx",
              file_type: "docx",
              storage_path: "mike-workflows/a1/precedent.docx",
              size_bytes: 9,
            },
          ],
          error: null,
        },
      ],
      documents: [{ data: null, error: null }],
      document_versions: [{ data: null, error: null }],
    });

    const result = await importWorkflowAddon(db, { addonId: "a1", userId: "u1" });

    expect(result).toEqual({
      ok: true,
      data: {
        id: "w1",
        user_id: "u1",
        metadata: {
          title: "Design Partner Draft",
          description: null,
          type: "assistant",
          contributors: [],
          language: "English",
          version: null,
          practice: "General Transactions",
          jurisdictions: ["General"],
        },
        skill_md: "Draft from the precedent.",
        columns_config: null,
        is_system: false,
        is_owner: true,
        allow_edit: true,
        created_at: "2026-08-28T00:00:00.000Z",
      },
    });
    expect(downloadFile).toHaveBeenCalledWith("mike-workflows/a1/precedent.docx");
    // Source bytes plus the converted PDF rendition for a Word file.
    expect(uploadFile).toHaveBeenCalledTimes(2);
    const documentInsert = calls.find(
      (c) => c.table === "documents" && c.op === "insert",
    );
    expect(documentInsert?.payload).toMatchObject({
      workflow_id: "w1",
      user_id: "u1",
      status: "processing",
      library_kind: "workflow_asset",
    });
    const versionInsert = calls.find(
      (c) => c.table === "document_versions" && c.op === "insert",
    );
    expect(versionInsert?.payload).toMatchObject({
      version_number: 1,
      filename: "Precedent.docx",
      file_type: "docx",
      size_bytes: 9,
    });
    const ready = calls.find((c) => c.table === "documents" && c.op === "update");
    expect(ready?.payload).toMatchObject({ status: "ready" });
  });

  it("rolls the workflow back and queues storage cleanup when an asset copy fails", async () => {
    downloadFile.mockResolvedValue(new TextEncoder().encode("reference").buffer);
    uploadFile.mockResolvedValue(undefined);
    prepareDocumentDisplay.mockResolvedValue({
      bytes: Buffer.from("converted-pdf"),
      contentType: "application/pdf",
      filename: "Precedent.pdf",
    });
    const { db, calls } = makeDb({
      mike_workflows: [{ data: catalogRow, error: null }],
      workflows: [{ data: workflowRow, error: null }, { data: null, error: null }],
      mike_workflow_assets: [
        {
          data: [
            {
              filename: "Precedent.docx",
              file_type: "docx",
              storage_path: "mike-workflows/a1/precedent.docx",
              size_bytes: 9,
            },
          ],
          error: null,
        },
      ],
      // The document insert fails after both objects are already uploaded.
      documents: [{ data: null, error: { message: "insert failed" } }],
    });

    const result = await importWorkflowAddon(db, { addonId: "a1", userId: "u1" });

    expect(result).toEqual({
      ok: false,
      kind: "assets_copy_failed",
      detail: "Failed to copy add-on assets",
    });
    // Row first, then the durable object deletes — nothing may point at the
    // half-made copies while the cleanup job drains.
    const rollback = calls.find((c) => c.table === "workflows" && c.op === "delete");
    expect(rollback?.filters).toEqual([
      ["eq", "id", "w1"],
      ["eq", "user_id", "u1"],
    ]);
    expect(enqueueStorageCleanup).toHaveBeenCalledTimes(1);
    const [, paths] = enqueueStorageCleanup.mock.calls[0] as [unknown, string[]];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/^documents\/u1\/.+\/source\.docx$/);
    expect(paths[1]).toMatch(/^converted-pdfs\/u1\/.+\.pdf$/);
  });
});
