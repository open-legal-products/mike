import { expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { findDocumentText, readStoredDocumentText } from "../documents.textSearch";
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
