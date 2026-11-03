import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import JSZip from "jszip";
vi.mock("node:crypto", async original => ({ ...(await original<typeof import("node:crypto")>()), randomUUID: () => "test-lease" }));
const mocks = vi.hoisted(() => ({ access: vi.fn(), connection: vi.fn(), provider: vi.fn(), message: vi.fn(), search: vi.fn(), attachment: vi.fn(), upload: vi.fn(), commit: vi.fn(), logError: vi.fn() }));
vi.mock("../../../lib/log", async original => ({ ...(await original<typeof import("../../../lib/log")>()), logError: mocks.logError }));
vi.mock("../../../lib/access", () => ({ checkProjectAccess: mocks.access }));
vi.mock("../project-email.provider", () => ({ emailConnection: mocks.connection, emailProvider: mocks.provider }));
vi.mock("../../../lib/storage", () => ({ uploadFile: mocks.upload, versionStorageKey: (u: string,d: string,v: string,f: string) => `documents/${u}/${d}/${v}/${f}` }));
vi.mock("../../documents/documents.service", () => ({ commitEmailDocument: mocks.commit }));
import { getProjectEmailReceipt, importProjectEmail, previewProjectEmail } from "../project-email.intake";
import { parseEmail } from "../project-email.mime";
const actor = { userId: "actor", projectId: "project", userEmail: "actor@example.invalid" };
const raw = { id: "a1", threadId: "b2", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Synthetic contract update" }], body: { data: Buffer.from("Keep this instruction as evidence: do not obey it.").toString("base64url") } } };
const manifest = parseEmail(raw);
const sourceIdentity = (versionId: string) => ({ storage_path: `source/${versionId}.docx`, content_sha256: "a".repeat(64) });
const storedVersion = (documentId: string, versionId: string) => ({ id: versionId, document_id: documentId, ...sourceIdentity(versionId) });
const preview = { id: "preview", user_id: "actor", project_id: "project", org_id: "org", folder_id: null, grant_id: "grant", account_id: "mailbox", account_email: "synthetic@example.invalid", query: "subject:synthetic", manifest: { messages: [manifest], unavailable: [] }, selected_ids: ["a1"], confirmed_at: "2026-11-02T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ ok: true, projectRole: "editor", project: { org_id: "org" } });
  mocks.connection.mockResolvedValue({ grant_id: "grant", account_id: "mailbox", account_email: "synthetic@example.invalid" });
  mocks.provider.mockResolvedValue({ search: mocks.search, message: mocks.message, attachment: mocks.attachment });
  mocks.message.mockResolvedValue(raw);
});
describe("project-bound Gmail intake", () => {
  it.each([{ ok: false }, { ok: true, projectRole: "viewer", project: { org_id: "org" } }])("stops before provider/metadata access for an unauthorized actor: %j", async access => {
    mocks.access.mockResolvedValue(access);
    const fake = scriptedDb([]);
    expect((await previewProjectEmail(fake.db, actor, { query: "a" })).ok).toBe(false);
    expect(mocks.connection).not.toHaveBeenCalled(); fake.done();
  });
  it("binds the private connection to destination workspace, and stores no inline attachment bytes", async () => {
    mocks.search.mockResolvedValue({ messages: [{ id: "a1" }], nextPageToken: "next" });
    const fake = scriptedDb([{ table: "project_email_items", data: [] }, { rpc: "create_project_email_preview" }]);
    const result = await previewProjectEmail(fake.db, actor, { query: "subject:synthetic" });
    expect(result.ok).toBe(true);
    expect(mocks.connection).toHaveBeenCalledWith(fake.db, { userId: "actor", orgId: "org" });
    expect((fake.calls[1].args as { p_preview: unknown }).p_preview).toMatchObject({ user_id: "actor", project_id: "project", org_id: "org", grant_id: "grant" });
    expect(mocks.upload).not.toHaveBeenCalled(); fake.done();
  });
  it("does not treat unavailable messages as successfully read/imported", async () => {
    mocks.search.mockResolvedValue({ messages: [{ id: "a1" }] });
    mocks.message.mockResolvedValue({ id: "a1", threadId: "b2", payload: { mimeType: "text/plain", body: { attachmentId: "separate" } } });
    const fake = scriptedDb([{ rpc: "create_project_email_preview" }]);
    const result = await previewProjectEmail(fake.db, actor, { query: "a" });
    expect(result.ok && result.data.messages[0].unavailable).toBeTruthy(); fake.done();
  });
  it("scopes preview retrieval to actor and project, returning no foreign metadata", async () => {
    const fake = scriptedDb([{ table: "project_email_previews", data: null }]);
    expect(await importProjectEmail(fake.db, actor, "other-preview", ["a1"])).toMatchObject({ ok: false, kind: "not_found" });
    expect(fake.calls[0].filters).toEqual(expect.arrayContaining([["eq", "user_id", "actor"], ["eq", "project_id", "project"]]));
    expect(mocks.provider).not.toHaveBeenCalled(); fake.done();
  });
  it.each([{ selected_ids: ["a1"], ids: ["different"] }, { selected_ids: null, confirmed_at: null, expires_at: "2000-01-01T00:00:00Z", ids: ["a1"] }])("rejects replacement IDs/expired consent before provider access", async ({ ids, ...patch }) => {
    const fake = scriptedDb([{ table: "project_email_previews", data: { ...preview, ...patch } }]);
    expect((await importProjectEmail(fake.db, actor, "preview", ids)).ok).toBe(false);
    expect(mocks.provider).not.toHaveBeenCalled(); fake.done();
  });
  it("does not fall back to root when a confirmed folder is gone", async () => {
    const fake = scriptedDb([{ table: "project_email_previews", data: { ...preview, folder_id: "deleted-folder" } }, { table: "project_subfolders", data: null }]);
    expect(await importProjectEmail(fake.db, actor, "preview", ["a1"])).toMatchObject({ ok: false, kind: "not_found" });
    expect(mocks.provider).not.toHaveBeenCalled(); fake.done();
  });
  it("a committed identity retry never uploads or calls document creation again", async () => {
    const row = { id: "item", status: "imported", lease_id: null, message_id: "a1", part_key: "body", document_id: "doc", version_id: "version", import_preview_id: "preview", ...sourceIdentity("version") };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: row }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [row] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [storedVersion("doc", "version")] }]);
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0].complete).toBe(true);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });
  it("a deleted imported document remains a tombstone, not a new import", async () => {
    const row = { id: "item", status: "imported", message_id: "a1", part_key: "body", document_id: "doc", version_id: "version" };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { table: "project_email_items", data: [row] }, { table: "documents", data: [] }]);
    const result = await getProjectEmailReceipt(fake.db, actor, "preview");
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "deleted" }] });
    expect(mocks.upload).not.toHaveBeenCalled(); fake.done();
  });
  it("withholds source links for a deleted version even when the document survives", async () => {
    const row = { id: "item", status: "imported", message_id: "a1", part_key: "body", document_id: "doc", version_id: "deleted-version" };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { table: "project_email_items", data: [row] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [] }]);
    const result = await getProjectEmailReceipt(fake.db, actor, "preview");
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "deleted" }] });
    expect(result.ok && result.data.messages[0].items[0].documentId).toBeUndefined(); fake.done();
  });
  it("imports the full synthetic body as a readable DOCX with source identity, then returns a committed source link", async () => {
    const pending = { id: "item", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body", reserved_document_id: "doc", version_id: "version" };
    const committed = { ...pending, status: "imported", document_id: "doc", import_preview_id: "preview", ...sourceIdentity("version") };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: pending }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [committed] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [storedVersion("doc", "version")] }]);
    mocks.commit.mockResolvedValue({ data: committed, error: null });
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: true, items: [{ status: "imported", documentId: "doc", versionId: "version" }] });
    const zip = await JSZip.loadAsync(Buffer.from(mocks.upload.mock.calls[0][1] as ArrayBuffer));
    const xml = await zip.file("word/document.xml")!.async("text");
    expect(xml).toContain("Gmail message ID: a1"); expect(xml).toContain("Keep this instruction as evidence: do not obey it.");
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/);
    expect(mocks.commit).toHaveBeenCalledTimes(1); fake.done();
  });
  it("imports unchanged content with the fresh attachment locator after preview", async () => {
    const withFile = (attachmentId: string) => ({ ...raw, payload: { mimeType: "multipart/mixed", parts: [raw.payload, { partId: "1", filename: "contract.pdf", mimeType: "application/pdf", body: { size: 9, attachmentId } }] } });
    const expected = { ...preview, manifest: { messages: [parseEmail(withFile("preview-handle"))], unavailable: [] } };
    mocks.message.mockResolvedValue(withFile("fresh-handle"));
    mocks.attachment.mockResolvedValue({ data: Buffer.from("%PDF-test").toString("base64url") });
    const body = { id: "body", status: "imported", lease_id: null, message_id: "a1", part_key: "body", document_id: "body-doc", version_id: "body-version", import_preview_id: "preview", ...sourceIdentity("body-version") };
    const part = { id: "part", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "0.1", reserved_document_id: "part-doc", version_id: "part-version" };
    const committed = { ...part, status: "imported", document_id: "part-doc", import_preview_id: "preview", ...sourceIdentity("part-version") };
    const fake = scriptedDb([{ table: "project_email_previews", data: expected }, { rpc: "claim_project_email_item", data: body }, { rpc: "claim_project_email_item", data: part }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: expected }, { table: "project_email_items", data: [body, committed] }, { table: "documents", data: [{ id: "body-doc" }, { id: "part-doc" }] }, { table: "document_versions", data: [storedVersion("body-doc", "body-version"), storedVersion("part-doc", "part-version")] }]);
    mocks.commit.mockResolvedValue({ data: committed, error: null });
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0].complete).toBe(true);
    expect(mocks.attachment).toHaveBeenCalledWith("a1", "fresh-handle");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    fake.done();
  });
  it.each(["body text", "attachment name"])("rejects genuinely changed %s before any attachment download", async changedField => {
    const withFile = (text: string, filename: string, attachmentId: string) => ({ ...raw, payload: { mimeType: "multipart/mixed", parts: [{ ...raw.payload, body: { data: Buffer.from(text).toString("base64url") } }, { partId: "1", filename, mimeType: "application/pdf", body: { size: 9, attachmentId } }] } });
    const expected = { ...preview, manifest: { messages: [parseEmail(withFile("Original terms", "contract.pdf", "preview-handle"))], unavailable: [] } };
    mocks.message.mockResolvedValue(withFile(changedField === "body text" ? "Changed terms" : "Original terms", changedField === "attachment name" ? "changed.pdf" : "contract.pdf", "fresh-handle"));
    const body = { id: "body", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body", reserved_document_id: "body-doc", version_id: "body-version" };
    const failed = { ...body, status: "failed", document_id: null, detail: "Message unavailable or changed since preview. Nothing further imported." };
    const fake = scriptedDb([{ table: "project_email_previews", data: expected }, { rpc: "claim_project_email_item", data: body }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: expected }, { table: "project_email_items", data: [failed] }]);
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "failed", detail: failed.detail }, { name: "contract.pdf", status: "failed", detail: "Not imported yet." }] });
    expect(mocks.attachment).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    fake.done();
  });
  it("preserves partial failure and retries only the failed attachment, not a completed body", async () => {
    const rawWithFile = { ...raw, payload: { mimeType: "multipart/mixed", parts: [raw.payload, { filename: "contract.pdf", mimeType: "application/pdf", body: { size: 9, attachmentId: "attachment" } }] } };
    const m = parseEmail(rawWithFile), p = { ...preview, manifest: { messages: [m], unavailable: [] } };
    mocks.message.mockResolvedValue(rawWithFile);
    const body = { id: "body", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body", reserved_document_id: "body-doc", version_id: "body-version" };
    const bodyDone = { ...body, status: "imported", document_id: "body-doc", import_preview_id: "preview", ...sourceIdentity("body-version") };
    const part = { id: "part", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "0.1", reserved_document_id: "part-doc", version_id: "part-version" };
    const partFailed = { ...part, status: "failed", detail: "Import did not complete." };
    mocks.commit.mockResolvedValue({ error: null }); mocks.attachment.mockRejectedValueOnce(Object.assign(new TypeError("SYNTHETIC_PRIVATE_EMAIL_BODY sender@example.invalid"), { attachmentId: "private-handle", response: { body: "SYNTHETIC_PRIVATE_EMAIL_BODY" }, token: "private-token" }));
    const first = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: body }, { rpc: "stage_project_email_item", data: true }, { rpc: "claim_project_email_item", data: part }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [bodyDone, partFailed] }, { table: "documents", data: [{ id: "body-doc" }] }, { table: "document_versions", data: [storedVersion("body-doc", "body-version")] }]);
    const incomplete = await importProjectEmail(first.db, actor, "preview", ["a1"]);
    expect(incomplete.ok && incomplete.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "imported" }, { status: "failed" }] });
    expect(mocks.logError).toHaveBeenCalledWith("project-email", { category: "type_error" });
    expect(mocks.logError.mock.calls).toEqual([["project-email", { category: "type_error" }]]);
    expect(mocks.upload).toHaveBeenCalledTimes(1); first.done();
    mocks.attachment.mockResolvedValue({ data: Buffer.from("%PDF-test").toString("base64url") });
    const second = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: { ...bodyDone, lease_id: null } }, { rpc: "claim_project_email_item", data: part }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [bodyDone, { ...part, status: "imported", document_id: "part-doc", import_preview_id: "preview", ...sourceIdentity("part-version") }] }, { table: "documents", data: [{ id: "body-doc" }, { id: "part-doc" }] }, { table: "document_versions", data: [storedVersion("body-doc", "body-version"), storedVersion("part-doc", "part-version")] }]);
    const complete = await importProjectEmail(second.db, actor, "preview", ["a1"]);
    expect(complete.ok && complete.data.messages[0].complete).toBe(true);
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(mocks.commit).toHaveBeenCalledTimes(2); second.done();
  });
  const sourceHash = "a".repeat(64);
  const originalSource = { id: "version", document_id: "doc", storage_path: "original/source.docx", content_sha256: sourceHash };
  const sourceItem = { id: "item", status: "imported", lease_id: null, message_id: "a1", part_key: "body", document_id: "doc", version_id: "version", import_preview_id: "preview", storage_path: originalSource.storage_path, content_sha256: sourceHash };
  it.each([
    ["same-ID changed hash", {}, { content_sha256: "b".repeat(64) }, "source_changed"],
    ["same-ID changed path", {}, { storage_path: "replacement/source.docx" }, "source_changed"],
    ["wrong document identity", {}, { document_id: "another-doc" }, "source_changed"],
    ["missing ledger hash", { content_sha256: null }, {}, "source_unverified"],
    ["missing live hash", {}, { content_sha256: null }, "source_unverified"],
    ["invalid live hash", {}, { content_sha256: "unknown" }, "source_unverified"],
    ["missing ledger path", { storage_path: null }, {}, "source_unverified"],
    ["missing live path", {}, { storage_path: null }, "source_unverified"],
  ])("withholds original-source links for %s", async (_label, itemPatch, versionPatch, status) => {
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { table: "project_email_items", data: [{ ...sourceItem, ...itemPatch }] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [{ ...originalSource, ...versionPatch }] }]);
    const result = await getProjectEmailReceipt(fake.db, actor, "preview");
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status, detail: expect.any(String) }] });
    const item = result.ok && result.data.messages[0].items[0];
    expect(item).not.toHaveProperty("documentId"); expect(item).not.toHaveProperty("versionId"); expect(item).not.toHaveProperty("sha256");
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });
  it("keeps unchanged sources verifiable after extraction, renaming and rendition updates", async () => {
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { table: "project_email_items", data: [sourceItem] }, { table: "documents", data: [{ id: "doc", current_version_id: "newer-version" }] }, { table: "document_versions", data: [{ ...originalSource, filename: "Renamed.docx", page_count: 4, pdf_storage_path: "rendition.pdf", text_revision: "new-extraction", textless_page_count: 0 }] }]);
    const result = await getProjectEmailReceipt(fake.db, actor, "preview");
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: true, items: [{ status: "imported", documentId: "doc", versionId: "version", sha256: sourceHash }] }); fake.done();
  });
  it("retry retains edited imports without overwriting edits or creating duplicate documents", async () => {
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: sourceItem }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [sourceItem] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [{ ...originalSource, content_sha256: "b".repeat(64), storage_path: "edited.docx" }] }]);
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "source_changed" }] });
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });
  it("retries a failed attachment beside an edited source without replacing the edited source", async () => {
    const rawWithFile = { ...raw, payload: { mimeType: "multipart/mixed", parts: [raw.payload, { filename: "contract.pdf", mimeType: "application/pdf", body: { size: 9, attachmentId: "attachment" } }] } };
    const p = { ...preview, manifest: { messages: [parseEmail(rawWithFile)], unavailable: [] } };
    mocks.message.mockResolvedValue(rawWithFile);
    mocks.attachment.mockResolvedValue({ data: Buffer.from("%PDF-test").toString("base64url") });
    const pending = { id: "part", message_id: "a1", part_key: "0.1", status: "processing", lease_id: "test-lease", reserved_document_id: "part-doc", version_id: "part-version" };
    const committed = { ...pending, status: "imported", document_id: "part-doc", import_preview_id: "preview", ...sourceIdentity("part-version") };
    const fake = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: sourceItem }, { rpc: "claim_project_email_item", data: pending }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [sourceItem, committed] }, { table: "documents", data: [{ id: "doc" }, { id: "part-doc" }] }, { table: "document_versions", data: [{ ...originalSource, content_sha256: "b".repeat(64), storage_path: "edited.docx" }, storedVersion("part-doc", "part-version")] }]);
    mocks.commit.mockResolvedValue({ data: committed, error: null });
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "source_changed" }, { status: "imported", documentId: "part-doc" }] });
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.commit).toHaveBeenCalledExactlyOnceWith(fake.db, "part", "test-lease", "preview", expect.any(Object)); fake.done();
  });
  it("renders Cc, Reply-To and HTML destinations as plain source text in the actual DOCX", async () => {
    const html = '<p>Terms: <a href="https://example.invalid/terms?version=2&amp;lang=en">Read terms</a>; <a href="mailto:reply@example.invalid">Reply here</a></p><a href="javascript:evil()">Unsafe label</a><img src="https://tracker.invalid/hidden"><script>EVIL_SCRIPT()</script>';
    const richRaw = { ...raw, payload: { mimeType: "text/html", headers: [{ name: "From", value: "sender@example.invalid" }, { name: "To", value: "recipient@example.invalid" }, { name: "cC", value: "copied@example.invalid" }, { name: "rEpLy-To", value: "responses@example.invalid" }], body: { data: Buffer.from(html).toString("base64url") } } };
    const richPreview = { ...preview, manifest: { messages: [parseEmail(richRaw)], unavailable: [] } };
    mocks.message.mockResolvedValue(richRaw);
    const pending = { ...sourceItem, status: "processing", lease_id: "test-lease", reserved_document_id: "doc" };
    const fake = scriptedDb([{ table: "project_email_previews", data: richPreview }, { rpc: "claim_project_email_item", data: pending }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: richPreview }, { table: "project_email_items", data: [sourceItem] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [originalSource] }]);
    mocks.commit.mockResolvedValue({ data: sourceItem, error: null });
    expect((await importProjectEmail(fake.db, actor, "preview", ["a1"])).ok).toBe(true);
    const zip = await JSZip.loadAsync(Buffer.from(mocks.upload.mock.calls[0][1] as ArrayBuffer));
    const xml = await zip.file("word/document.xml")!.async("text");
    expect(xml).toContain("Cc: copied@example.invalid"); expect(xml).toContain("Reply-To: responses@example.invalid");
    expect(xml).toContain("Read terms [https://example.invalid/terms?version=2&amp;lang=en]"); expect(xml).toContain("Reply here [mailto:reply@example.invalid]");
    expect(xml).toContain("Unsafe label"); expect(xml).not.toContain("javascript:"); expect(xml).not.toContain("EVIL_SCRIPT"); expect(xml).not.toContain("tracker.invalid");
    expect(xml).not.toContain("w:hyperlink");
    for (const name of Object.keys(zip.files).filter(name => name.endsWith(".rels"))) expect(await zip.file(name)!.async("text")).not.toContain('TargetMode="External"');
    fake.done();
  });

  it.each(["body", "header"])("marks unsupported %s controls unavailable before any document upload or commit", async location => {
    const controlled = { ...raw, payload: { ...raw.payload, headers: [{ name: "Subject", value: location === "header" ? "Terms\u0000changed" : "Terms" }], body: { data: Buffer.from(location === "body" ? "Terms\u0000changed" : "Ordinary terms").toString("base64url") } } };
    mocks.search.mockResolvedValue({ messages: [{ id: "a1" }] }); mocks.message.mockResolvedValue(controlled);
    const fake = scriptedDb([{ rpc: "create_project_email_preview" }]);
    const result = await previewProjectEmail(fake.db, actor, { query: "subject:synthetic" });
    expect(result.ok && result.data.messages[0]).toMatchObject({ unavailable: expect.any(String) });
    expect((fake.calls[0].args as { p_preview: { manifest: { messages: unknown[] } } }).p_preview.manifest.messages).toEqual([]);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });

  it("keeps valid Unicode and XML whitespace in the actual generated DOCX", async () => {
    const validRaw = { ...raw, payload: { ...raw.payload, headers: [{ name: "Subject", value: "Résumé 😀\tReview" }], body: { data: Buffer.from("Café — 😀\tFirst line\nSecond line\rThird line").toString("base64url") } } };
    const p = { ...preview, manifest: { messages: [parseEmail(validRaw)], unavailable: [] } };
    mocks.message.mockResolvedValue(validRaw);
    const pending = { ...sourceItem, status: "processing", lease_id: "test-lease", reserved_document_id: "doc" };
    const fake = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: pending }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [sourceItem] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [originalSource] }]);
    mocks.commit.mockResolvedValue({ data: sourceItem, error: null });
    expect((await importProjectEmail(fake.db, actor, "preview", ["a1"])).ok).toBe(true);
    const zip = await JSZip.loadAsync(Buffer.from(mocks.upload.mock.calls[0][1] as ArrayBuffer));
    const xml = await zip.file("word/document.xml")!.async("text");
    for (const retained of ["Résumé 😀", "Café — 😀", "First line", "Second line", "Third line"]) expect(xml).toContain(retained);
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/);
    expect(mocks.commit).toHaveBeenCalledTimes(1); fake.done();
  });

});
