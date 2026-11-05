import { expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { findDocumentText, readStoredDocumentText, storedDocumentTextCurrent } from "../documents.textSearch";
const id = "00000000-0000-4000-8000-000000000001";
it("passes only the authenticated actor and explicit workspace to the permission-scoped query", async () => {
  const fake = scriptedDb([{ rpc: "find_document_text", data: { matches: [], next_offset: null, coverage: {} } }]);
  expect((await findDocumentText(fake.db, { userId: id, userEmail: "actor@example.test", scope: "library", query: "100% consent" })).ok).toBe(true);
  expect(fake.calls[0].args).toEqual({ p_user_id: id, p_user_email: "actor@example.test", p_workspace: "personal", p_scope: "library", p_query: "100% consent", p_project_id: null, p_document_id: null, p_version_id: null, p_limit: 10, p_offset: 0 });
  fake.done();
});
it.each([
  { scope: "all", query: "clause" }, { scope: "library", query: "a" },
  { scope: "library", query: "x".repeat(501) }, { scope: "project", query: "clause" },
  { scope: "document", query: "clause", documentId: "not-a-uuid" },
  { scope: "library", query: "clause", limit: 1000 }, { scope: "library", query: "clause", offset: -1 },
  { scope: "library", query: "clause", versionId: id },
])("rejects unbounded or inconsistent input without querying: %j", async (args) => {
  const fake = scriptedDb([]);
  expect(await findDocumentText(fake.db, { userId: id, ...args })).toMatchObject({ ok: false, kind: "validation" }); fake.done();
});
it("reads an exact version through the same actor authorization", async () => {
  const fake = scriptedDb([{ rpc: "read_document_text", data: null }]);
  expect(await readStoredDocumentText(fake.db, { userId: "actor", documentId: "document", versionId: "historical" })).toBeNull();
  expect(fake.calls[0].args).toMatchObject({ p_user_id: "actor", p_document_id: "document", p_version_id: "historical" }); fake.done();
});
it("treats held text as current only while the actor may read it at the same live revision", async () => {
  const args = { userId: "actor", documentId: "document", versionId: "historical", revision: "r1" };
  for (const [access, version, expected] of [[true, { text_revision: "r1" }, true], [false, { text_revision: "r1" }, false], [true, { text_revision: "r2" }, false], [true, null, false]] as const) {
    const fake = scriptedDb([{ rpc: "document_text_access", data: access }, { table: "document_versions", data: version }]);
    expect(await storedDocumentTextCurrent(fake.db, args)).toBe(expected);
    expect(fake.calls[0].args).toEqual({ p_document_id: "document", p_user_id: "actor", p_user_email: null });
    expect(fake.calls[1].filters).toEqual([["eq", "id", "historical"], ["eq", "document_id", "document"], ["is", "deleted_at", null]]);
    fake.done();
  }
});
