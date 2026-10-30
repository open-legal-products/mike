import { beforeEach, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
const mocks = vi.hoisted(() => ({ state: vi.fn(), extract: vi.fn() }));
vi.mock("../../../lib/documentVersions", () => ({ attachActiveVersionPaths: vi.fn(async () => {}) }));
vi.mock("../../../lib/documentTextCache", async load => ({ ...await load<object>(), loadVersionTextState: mocks.state }));
vi.mock("../tabular.extract", () => ({ extractDocumentMarkdown: mocks.extract }));
import { loadRowDocumentText, type ReviewRow } from "../tabular.rows";
import { createTextExtractionCache } from "../../../lib/textExtractionCache";
const row = { id: "row", document_id: "doc" } as ReviewRow;
const fake = () => scriptedDb([{ table: "documents", data: [{ id: "doc", filename: "contract", storage_path: "source", current_version_id: "v", file_type: "docx" }] }]);
beforeEach(() => { vi.clearAllMocks(); mocks.extract.mockResolvedValue("Parsed"); });
it("reads indexed text without parsing for repeated generations", async () => {
    mocks.state.mockResolvedValue({ revision: "r1", text: "Stored", textlessPageCount: 0 });
    for (let i = 0; i < 3; i++) expect(await loadRowDocumentText(fake().db, row)).toContain("Stored");
    expect(mocks.extract).not.toHaveBeenCalled();
});
it("shares a cold source between concurrent rows and invalidates on revision changes", async () => {
    mocks.state.mockResolvedValue({ revision: "r1", text: null, textlessPageCount: 0 });
    const cache = createTextExtractionCache();
    const rows = await Promise.all(Array.from({ length: 20 }, () => loadRowDocumentText(fake().db, row, cache)));
    expect(rows.every(text => text.includes("Parsed"))).toBe(true);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    mocks.state.mockResolvedValue({ revision: "r2", text: null, textlessPageCount: 0 });
    await loadRowDocumentText(fake().db, row, cache);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
});
