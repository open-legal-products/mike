import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../__tests__/helpers/scriptedDb";
import { loadVersionTextState, cachedTextForModel } from "../documentTextCache";
describe("revision-bound text cache", () => {
    it("uses ready text only from the same live document/version/revision/path", async () => {
        const fake = scriptedDb([{ table: "document_versions", data: { text_revision: "new", document_version_texts: { extractor_version: 1, source_revision: "new", status: "ready", text_content: "clause", textless_page_count: 2 } } }]);
        const state = await loadVersionTextState(fake.db, "doc", "version", "source");
        expect(state).toEqual({ revision: "new", text: "clause", textlessPageCount: 2 });
        expect(fake.calls[0].filters).toEqual([["eq", "id", "version"], ["eq", "document_id", "doc"], ["is", "deleted_at", null], ["eq", "storage_path", "source"]]);
        expect(cachedTextForModel(state!)).toContain("need OCR"); fake.done();
    });
    it.each([['old', 'ready'], ['new', 'pending'], ['new', 'failed']])("refuses %s/%s text", async (revision, status) => {
        const fake = scriptedDb([{ table: "document_versions", data: { text_revision: "new", document_version_texts: { extractor_version: 1, source_revision: revision, status, text_content: "stale" } } }]);
        expect((await loadVersionTextState(fake.db, "doc", "version"))?.text).toBeNull();
    });
    it("refuses ready text produced by an obsolete extractor", async () => {
        const fake = scriptedDb([{ table: "document_versions", data: { text_revision: "new", document_version_texts: { extractor_version: 0, source_revision: "new", status: "ready", text_content: "old interpretation" } } }]);
        expect((await loadVersionTextState(fake.db, "doc", "version"))?.text).toBeNull();
    });
    it("distinguishes ready empty text from a missing cache entry", async () => {
        const fake = scriptedDb([{ table: "document_versions", data: { text_revision: "new", document_version_texts: [{ extractor_version: 1, source_revision: "new", status: "ready", text_content: "" }] } }]);
        expect((await loadVersionTextState(fake.db, "doc", "version"))?.text).toBe("");
    });
});
