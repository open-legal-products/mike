import { beforeEach, expect, it, vi } from "vitest";
import type { DocIndex, DocStore } from "../../types";
import type { Db } from "../../../../../lib/supabase";
const mocks = vi.hoisted(() => ({ active: vi.fn(), text: vi.fn(), extract: vi.fn(), bytes: vi.fn() }));
vi.mock("../../../../../lib/documentVersions", async load => ({ ...await load<object>(), loadActiveVersion: mocks.active }));
vi.mock("../../../../../lib/documentTextCache", async load => ({ ...await load<object>(), loadVersionTextState: mocks.text }));
vi.mock("../../../../documents/documents.service", async load => ({ ...await load<object>(), loadCurrentVersionBytes: mocks.bytes }));
vi.mock("../../../../../lib/extraction/isolated", async load => ({ ...await load<object>(), withExtractionRequest: (work: (extract: typeof mocks.extract) => unknown) => work(mocks.extract) }));
import { readDocumentContent } from "../documentOps";
const index: DocIndex = { D1: { document_id: "doc", filename: "test.docx", version_id: "version" } };
const store = (): DocStore => new Map([["D1", { storage_path: "source", filename: "test.docx", file_type: "docx" }]]);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.active.mockResolvedValue({ id: "version", version_number: 1, storage_path: "source", text_revision: "r1" });
  mocks.text.mockResolvedValue({ revision: "r1", text: "Cached contract", textlessPageCount: 0 });
  mocks.bytes.mockResolvedValue({ bytes: Buffer.from("bytes"), storage_path: "source" });
  mocks.extract.mockResolvedValue("Parsed contract");
});
it("serves current persisted text without downloading or parsing", async () => {
  expect(await readDocumentContent("D1", store(), () => {}, index, {} as Db)).toBe("Cached contract");
  expect(mocks.bytes).not.toHaveBeenCalled(); expect(mocks.extract).not.toHaveBeenCalled();
});
it("reuses the turn's fallback extraction for citation verification", async () => {
  mocks.text.mockResolvedValue({ revision: "r1", text: null, textlessPageCount: 0 });
  const docs = store();
  expect(await readDocumentContent("D1", docs, () => {}, index, {} as Db)).toBe("Parsed contract");
  expect(await readDocumentContent("D1", docs, () => {}, index, {} as Db, { emitEvents: false })).toBe("Parsed contract");
  expect(mocks.extract).toHaveBeenCalledTimes(1); expect(mocks.bytes).toHaveBeenCalledTimes(1);
});
it("invalidates an in-place edit even if version ID and storage path are reused", async () => {
  const docs = store();
  await readDocumentContent("D1", docs, () => {}, index, {} as Db);
  mocks.active.mockResolvedValue({ id: "version", storage_path: "source", text_revision: "r2" });
  mocks.text.mockResolvedValue({ revision: "r2", text: "Edited contract", textlessPageCount: 0 });
  expect(await readDocumentContent("D1", docs, () => {}, index, {} as Db, { emitEvents: false })).toBe("Edited contract");
  expect(mocks.text).toHaveBeenCalledTimes(2);
});
it("keeps turn caches separate", async () => {
  await readDocumentContent("D1", store(), () => {}, index, {} as Db);
  await readDocumentContent("D1", store(), () => {}, index, {} as Db);
  expect(mocks.text).toHaveBeenCalledTimes(2);
});
