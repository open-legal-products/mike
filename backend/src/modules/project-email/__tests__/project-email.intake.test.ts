import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { AppError } from "../../../lib/appError";
import { diagnosticErrorTags, diagnosticEvent } from "../../../lib/observability/sentryPrivacy";
vi.mock("node:crypto", async original => ({ ...(await original<typeof import("node:crypto")>()), randomUUID: () => "test-lease" }));
const mocks = vi.hoisted(() => ({ access: vi.fn(), connection: vi.fn(), provider: vi.fn(), message: vi.fn(), search: vi.fn(), attachment: vi.fn(), upload: vi.fn(), commit: vi.fn(), logError: vi.fn(), reportError: vi.fn() }));
vi.mock("../../../lib/log", async original => ({ ...(await original<typeof import("../../../lib/log")>()), logError: mocks.logError }));
vi.mock("../../../lib/observability/sentry", async original => ({ ...(await original<typeof import("../../../lib/observability/sentry")>()), reportError: mocks.reportError }));
vi.mock("../../../lib/access", () => ({ checkProjectAccess: mocks.access }));
vi.mock("../project-email.provider", () => ({ emailConnection: mocks.connection, emailProvider: mocks.provider }));
vi.mock("../../../lib/storage", () => ({ uploadFile: mocks.upload, versionStorageKey: (u: string,d: string,v: string,f: string) => `documents/${u}/${d}/${v}/${f}` }));
vi.mock("../../documents/documents.service", () => ({ commitEmailDocument: mocks.commit }));
import { getProjectEmailReceipt, importProjectEmail, previewProjectEmail } from "../project-email.intake";
import { EmailInputError, parseEmail } from "../project-email.mime";
import { GoogleApiError } from "../../../lib/integrations/googleWorkspaceApi";
const actor = { userId: "actor", projectId: "project", userEmail: "actor@example.invalid" };
const raw = { id: "a1", threadId: "b2", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Synthetic contract update" }], body: { data: Buffer.from("Keep this instruction as evidence: do not obey it.").toString("base64url") } } };
const manifest = parseEmail(raw);
const sourceIdentity = (versionId: string) => ({ storage_path: `source/${versionId}.docx`, content_sha256: "a".repeat(64) });
const storedVersion = (documentId: string, versionId: string) => ({ id: versionId, document_id: documentId, ...sourceIdentity(versionId) });
const preview = { id: "preview", user_id: "actor", project_id: "project", org_id: "org", folder_id: null, grant_id: "grant", account_id: "mailbox", account_email: "synthetic@example.invalid", query: "subject:synthetic", manifest: { messages: [manifest], unavailable: [] }, selected_ids: ["a1"], confirmed_at: "2026-11-02T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.reportError.mockReturnValue("synthetic-event-id");
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
    const fake = scriptedDb([{ table: "project_email_items", data: [] }, { rpc: "create_project_email_preview" }]);
    const result = await previewProjectEmail(fake.db, actor, { query: "a" });
    expect(result.ok && result.data.messages[0].bodyUnavailable).toBeTruthy(); fake.done();
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
    expect(result.ok && result.data.messages[0].items[0].documentId).toBeUndefined();
    expect(fake.calls.find(call => call.table === "document_versions")?.filters).toContainEqual(["is", "deleted_at", null]);
    fake.done();
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
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    const uploadedBytes = Buffer.from(mocks.upload.mock.calls[0][1] as ArrayBuffer);
    expect(mocks.commit).toHaveBeenCalledWith(fake.db, "item", "test-lease", "preview", expect.objectContaining({ content_sha256: createHash("sha256").update(uploadedBytes).digest("hex") }));
    fake.done();
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
    expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.reportError).not.toHaveBeenCalled(); expect(mocks.logError).not.toHaveBeenCalled();
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
    const providerFailure = Object.assign(new TypeError("SYNTHETIC_PRIVATE_EMAIL_BODY sender@example.invalid"), { code: "ECONNRESET", status: 503, attachmentId: "private-handle", response: { body: "SYNTHETIC_PRIVATE_EMAIL_BODY" }, token: "private-token" });
    mocks.commit.mockResolvedValue({ error: null }); mocks.attachment.mockRejectedValueOnce(providerFailure);
    const first = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: body }, { rpc: "stage_project_email_item", data: true }, { rpc: "claim_project_email_item", data: part }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [bodyDone, partFailed] }, { table: "documents", data: [{ id: "body-doc" }] }, { table: "document_versions", data: [storedVersion("body-doc", "body-version")] }]);
    const incomplete = await importProjectEmail(first.db, actor, "preview", ["a1"]);
    expect(incomplete.ok && incomplete.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "imported" }, { status: "failed" }] });
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = mocks.reportError.mock.calls[0];
    expect(reported).toBeInstanceOf(AppError); expect(reported.cause).toBe(providerFailure);
    expect(context).toEqual({ tags: { component: "project-email", operation: "project_email.import", stage: "read-source" } });
    const event = diagnosticEvent({ tags: { ...context.tags, ...diagnosticErrorTags(reported) } });
    expect(event.tags).toMatchObject({ stage: "read-source", error_kind: "project_email.item_failed", failure_code: "ECONNRESET", dependency_status: 503 });
    for (const privateValue of ["SYNTHETIC_PRIVATE_EMAIL_BODY", "sender@example.invalid", "private-handle", "private-token"]) expect(JSON.stringify(event)).not.toContain(privateValue);
    expect(mocks.logError).not.toHaveBeenCalled();
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
    ["changed path despite missing ledger hash", { content_sha256: null }, { storage_path: "replacement/source.docx" }, "source_changed"],
    ["changed hash despite missing ledger path", { storage_path: null }, { content_sha256: "b".repeat(64) }, "source_changed"],
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
    const fake = scriptedDb([{ table: "project_email_items", data: [] }, { rpc: "create_project_email_preview" }]);
    const result = await previewProjectEmail(fake.db, actor, { query: "subject:synthetic" });
    expect(result.ok && result.data.messages[0]).toMatchObject({ bodyUnavailable: expect.any(String) });
    const stored = (fake.calls[1].args as { p_preview: { manifest: { messages: Array<{ text: string; bodyUnavailable?: string }> } } }).p_preview.manifest.messages[0];
    expect(stored).toMatchObject({ text: "", bodyUnavailable: expect.any(String) });
    expect(JSON.stringify(stored)).not.toContain("Terms\\u0000changed");
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

  it.each([
    ["staging", "stage-source", "P0001"],
    ["storage", "upload-source", "ECONNRESET"],
    ["commit", "commit-document", "23514"],
  ])("reports %s failure with its original technical cause and a fixed step", async (step, stage, code) => {
    const privateValues = ["PRIVATE_SUBJECT", "PRIVATE_BODY", "private-address@example.invalid", "private-message-id", "private-attachment-id", "private/storage/path", "private-credential"];
    const cause = { message: privateValues.join(" "), details: privateValues, code, status: 503 };
    const pending = { id: "item", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body", reserved_document_id: "doc", version_id: "version" };
    const failed = { ...pending, status: "failed", document_id: null, detail: "Import did not complete. Retry the confirmed selection or inspect the original." };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: pending }, { rpc: "stage_project_email_item", data: step === "staging" ? null : true, error: step === "staging" ? cause : undefined }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [failed] }]);
    if (step === "storage") mocks.upload.mockRejectedValue(cause);
    if (step === "commit") mocks.commit.mockResolvedValue({ error: cause });
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "failed", detail: failed.detail }] });
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = mocks.reportError.mock.calls[0];
    expect(reported).toBeInstanceOf(AppError); expect(reported.cause).toBe(cause);
    expect(context).toEqual({ tags: { component: "project-email", operation: "project_email.import", stage } });
    const event = diagnosticEvent({ tags: { ...context.tags, ...diagnosticErrorTags(reported) }, extra: { response: cause } });
    expect(event.tags).toMatchObject({ stage, error_kind: "project_email.item_failed", dependency_status: 503 });
    // Preserve every upstream cause locally; only approved technical codes leave the process.
    if (code === "P0001") expect(event.tags).not.toHaveProperty("failure_code");
    else expect(event.tags).toMatchObject({ failure_code: code });
    for (const value of privateValues) expect(JSON.stringify(event)).not.toContain(value);
    expect(mocks.logError).not.toHaveBeenCalled(); fake.done();
  });

  it.each(["provider 503", "unavailable validation"])("preserves the reporting boundary for message-fetch %s", async scenario => {
    const privateValues = ["FETCH_SUBJECT", "FETCH_BODY", "fetch-private@example.invalid", "fetch-message-id", "fetch-attachment-id", "fetch/storage/path", "fetch-credential"];
    const cause = new Error(privateValues.join(" "));
    const providerFailure = Object.assign(new GoogleApiError(privateValues.join(" "), 503), { cause, response: { body: privateValues } });
    const unexpected = scenario === "provider 503";
    mocks.message.mockRejectedValue(unexpected ? providerFailure : new EmailInputError("Email content is unavailable."));
    const detail = unexpected ? "Import did not complete. Retry the confirmed selection or inspect the original." : "Message unavailable or changed since preview. Nothing further imported.";
    const pending = { id: "item", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body", reserved_document_id: "doc", version_id: "version" };
    const failed = { ...pending, status: "failed", document_id: null, detail };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: pending }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [failed] }]);
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "failed", detail }] });
    expect(fake.calls.find(call => call.table === "project_email_items" && call.op === "update")?.payload).toMatchObject({ status: "failed", detail });
    if (unexpected) {
      expect(mocks.reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = mocks.reportError.mock.calls[0];
      expect(reported).toBe(providerFailure); expect(reported.cause).toBe(cause);
      expect(context).toEqual({ tags: { component: "project-email", operation: "project_email.import", stage: "read-source" } });
      const event = diagnosticEvent({ tags: { ...context.tags, ...diagnosticErrorTags(reported) }, extra: { response: providerFailure } });
      expect(event.tags).toMatchObject({ error_kind: "google.api_failed", dependency_status: 503, stage: "read-source" });
      for (const value of privateValues) expect(JSON.stringify(event)).not.toContain(value);
    } else expect(mocks.reportError).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });
  it("reports a retry fetch failure even when its body is already imported", async () => {
    const withFile = { ...raw, payload: { mimeType: "multipart/mixed", parts: [raw.payload, { filename: "contract.pdf", mimeType: "application/pdf", body: { size: 9, attachmentId: "attachment" } }] } };
    const p = { ...preview, manifest: { messages: [parseEmail(withFile)], unavailable: [] } };
    const providerFailure = Object.assign(new GoogleApiError("PRIVATE_RETRY_BODY private-retry@example.invalid", 503), { response: { body: "PRIVATE_RETRY_BODY" } });
    mocks.message.mockRejectedValue(providerFailure);
    const body = { ...sourceItem, status: "imported", lease_id: null };
    const attachment = { id: "part", message_id: "a1", part_key: "0.1", status: "failed", detail: "Previous attachment attempt failed." };
    const fake = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: body }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [body, attachment] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [originalSource] }]);
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "imported" }, { status: "failed", detail: attachment.detail }] });
    expect(mocks.reportError).toHaveBeenCalledExactlyOnceWith(providerFailure, { tags: { component: "project-email", operation: "project_email.import", stage: "read-source" } });
    const event = diagnosticEvent({ tags: { ...mocks.reportError.mock.calls[0][1].tags, ...diagnosticErrorTags(providerFailure) } });
    expect(event.tags).toMatchObject({ dependency_status: 503 }); expect(JSON.stringify(event)).not.toContain("PRIVATE_RETRY_BODY"); expect(JSON.stringify(event)).not.toContain("private-retry@example.invalid");
    expect(fake.calls.filter(call => call.op === "update")).toEqual([]);
    expect(mocks.logError).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });
  it.each([["disabled", null], ["enabled", "synthetic-event-id"]])("uses a safe local fallback only when reporting is %s", async (_state, eventId) => {
    mocks.reportError.mockReturnValue(eventId);
    const privateValues = ["LOCAL_SUBJECT", "LOCAL_BODY", "local-private@example.invalid", "local-message-id", "local-attachment-id", "local/storage/path", "local-credential"];
    const cause = Object.assign(new TypeError(privateValues.join(" ")), { response: { body: privateValues }, token: "local-credential" });
    mocks.upload.mockRejectedValue(cause);
    const pending = { id: "item", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body", reserved_document_id: "doc", version_id: "version" };
    const detail = "Import did not complete. Retry the confirmed selection or inspect the original.";
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: pending }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [{ ...pending, status: "failed", document_id: null, detail }] }]);
    expect((await importProjectEmail(fake.db, actor, "preview", ["a1"])).ok).toBe(true);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError.mock.calls[0][0].cause).toBe(cause);
    if (eventId === null) {
      expect(mocks.logError).toHaveBeenCalledExactlyOnceWith("project-email", { category: "type_error" }, { stage: "upload-source" });
      expect(mocks.reportError.mock.invocationCallOrder[0]).toBeLessThan(mocks.logError.mock.invocationCallOrder[0]);
      for (const value of privateValues) expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(value);
    } else expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });

  const partialSource = (data = "*", inline = false) => ({ id: "a1", threadId: "b2", payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "Synthetic attachment-only import" }], parts: [
    { mimeType: "text/plain", body: { data } },
    { filename: "contract.pdf", mimeType: "application/pdf", body: { size: 9, ...(inline ? { data: Buffer.from("%PDF-test").toString("base64url") } : { attachmentId: "attachment" }) } },
  ] } });
  it("previews body exclusion with safe consent text and metadata-only attachments", async () => {
    mocks.search.mockResolvedValue({ messages: [{ id: "a1" }] }); mocks.message.mockResolvedValue(partialSource("*", true));
    const fake = scriptedDb([{ table: "project_email_items", data: [] }, { rpc: "create_project_email_preview" }]);
    const result = await previewProjectEmail(fake.db, actor, { query: "a" });
    expect(result.ok && result.data.messages[0]).toMatchObject({ bodyUnavailable: expect.any(String), excerpt: expect.stringContaining("Supported attachments only"), attachments: [{ name: "contract.pdf", size: 9, excluded: undefined }] });
    const stored = (fake.calls[1].args as { p_preview: { manifest: { messages: Array<{ text: string; parts: Array<{ data?: string }> }> } } }).p_preview.manifest.messages[0];
    expect(stored.text).toBe(""); expect(stored.parts[0].data).toBeUndefined(); fake.done();
  });
  it("imports and retries only a valid inline attachment, retaining an excluded body without a placeholder DOCX", async () => {
    const source = partialSource("*", true), m = parseEmail(source), p = { ...preview, manifest: { messages: [m], unavailable: [] }, selected_ids: null, confirmed_at: null };
    mocks.message.mockResolvedValue(source);
    const body = { id: "body", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body", reserved_document_id: "body-doc", version_id: "body-version" };
    const excluded = { ...body, status: "excluded", lease_id: null, detail: m.bodyUnavailable };
    const part = { id: "part", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "0.1", reserved_document_id: "part-doc", version_id: "part-version" };
    const committed = { ...part, status: "imported", lease_id: null, document_id: "part-doc", import_preview_id: "preview", ...sourceIdentity("part-version") };
    const confirmed = { ...p, selected_ids: ["a1"], confirmed_at: "now" };
    const fake = scriptedDb([{ table: "project_email_previews", data: p }, { table: "project_email_previews", op: "update", data: { id: "preview" } }, { rpc: "claim_project_email_item", data: body }, { table: "project_email_items", op: "update", data: { id: "body" } }, { rpc: "claim_project_email_item", data: part }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: confirmed }, { table: "project_email_items", data: [excluded, committed] }, { table: "documents", data: [{ id: "part-doc" }] }, { table: "document_versions", data: [storedVersion("part-doc", "part-version")] }]);
    mocks.commit.mockResolvedValue({ error: null });
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "excluded", detail: m.bodyUnavailable }, { status: "imported", documentId: "part-doc" }] });
    const saved = fake.calls.find(c => c.table === "project_email_previews" && c.op === "update")!.payload as { manifest: { messages: Array<{ text: string; parts: Array<{ data?: string }> }> } };
    expect(saved.manifest.messages[0].text).toBe(""); expect(saved.manifest.messages[0].parts[0].data).toBeUndefined();
    expect(fake.calls.find(c => c.table === "project_email_items" && c.op === "update")!.payload).toMatchObject({ status: "excluded", detail: m.bodyUnavailable });
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(Buffer.from(mocks.upload.mock.calls[0][1])).toEqual(Buffer.from("%PDF-test"));
    expect(mocks.commit).toHaveBeenCalledExactlyOnceWith(fake.db, "part", "test-lease", "preview", expect.objectContaining({ file_type: "pdf" }));
    expect(mocks.attachment).not.toHaveBeenCalled(); fake.done();
    const retry = scriptedDb([{ table: "project_email_previews", data: confirmed }, { rpc: "claim_project_email_item", data: excluded }, { rpc: "claim_project_email_item", data: committed }, { table: "project_email_previews", data: confirmed }, { table: "project_email_items", data: [excluded, committed] }, { table: "documents", data: [{ id: "part-doc" }] }, { table: "document_versions", data: [storedVersion("part-doc", "part-version")] }]);
    expect((await importProjectEmail(retry.db, actor, "preview", ["a1"])).ok).toBe(true);
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.commit).toHaveBeenCalledTimes(1); retry.done();
  });
  it("rejects an attachment-only selection without an eligible part before confirmation or provider access", async () => {
    const m = { ...manifest, text: "", bodyUnavailable: "Unsupported email character encoding.", parts: [] };
    const fake = scriptedDb([{ table: "project_email_previews", data: { ...preview, manifest: { messages: [m], unavailable: [] }, selected_ids: null, confirmed_at: null } }]);
    expect(await importProjectEmail(fake.db, actor, "preview", ["a1"])).toMatchObject({ ok: false, kind: "validation" });
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });
  it("requires fresh consent when a legacy readable manifest now has an unavailable body", async () => {
    const source = partialSource(), parsed = parseEmail(source);
    const { bodyUnavailable: _bodyUnavailable, ...legacy } = parsed;
    const p = { ...preview, manifest: { messages: [legacy], unavailable: [] } };
    mocks.message.mockResolvedValue(source);
    const fake = scriptedDb([{ table: "project_email_previews", data: p }]);
    expect(await importProjectEmail(fake.db, actor, "preview", ["a1"])).toMatchObject({ ok: false, kind: "conflict" });
    expect(mocks.attachment).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); fake.done();
  });
  it("withholds a historical body link when the new confirmed preview declares body exclusion", async () => {
    const m = { ...manifest, text: "", bodyUnavailable: "Unsupported email character encoding." };
    const p = { ...preview, manifest: { messages: [m], unavailable: [] } };
    const row = { id: "body", status: "imported", message_id: "a1", part_key: "body", document_id: "doc", version_id: "version", import_preview_id: "old-preview", ...sourceIdentity("version") };
    const fake = scriptedDb([{ table: "project_email_previews", data: p }, { table: "project_email_items", data: [row] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [storedVersion("doc", "version")] }]);
    const result = await getProjectEmailReceipt(fake.db, actor, "preview");
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "excluded", detail: m.bodyUnavailable }] });
    expect(result.ok && result.data.messages[0].items[0].documentId).toBeUndefined(); fake.done();
  });
  it("labels detectably invalid legacy receipt metadata safely and never claims a complete body", async () => {
    const m = { ...manifest, subject: "PRIVATE\u0000SUBJECT" };
    const fake = scriptedDb([{ table: "project_email_previews", data: { ...preview, manifest: { messages: [m], unavailable: [] } } }, { table: "project_email_items", data: [] }]);
    const result = await getProjectEmailReceipt(fake.db, actor, "preview");
    expect(result.ok && result.data.messages[0]).toMatchObject({ subject: "[Subject unavailable]", complete: false, items: [{ status: "excluded" }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE"); fake.done();
  });

  it("retries a failed supported attachment while leaving the excluded body terminal", async () => {
    const source = partialSource(), m = parseEmail(source), p = { ...preview, manifest: { messages: [m], unavailable: [] } };
    mocks.message.mockResolvedValue(source);
    const body = { id: "body", status: "excluded", lease_id: null, message_id: "a1", part_key: "body", detail: m.bodyUnavailable };
    const part = { id: "part", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "0.1", reserved_document_id: "part-doc", version_id: "part-version" };
    mocks.attachment.mockResolvedValueOnce({ data: Buffer.from("bad-bytes").toString("base64url") });
    const first = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: body }, { rpc: "claim_project_email_item", data: part }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [body, { ...part, status: "failed" }] }]);
    const incomplete = await importProjectEmail(first.db, actor, "preview", ["a1"]);
    expect(incomplete.ok && incomplete.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "excluded" }, { status: "failed" }] });
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); first.done();
    mocks.attachment.mockResolvedValueOnce({ data: Buffer.from("%PDF-test").toString("base64url") }); mocks.commit.mockResolvedValue({ error: null });
    const committed = { ...part, status: "imported", lease_id: null, document_id: "part-doc", import_preview_id: "preview", ...sourceIdentity("part-version") };
    const retry = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: body }, { rpc: "claim_project_email_item", data: part }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [body, committed] }, { table: "documents", data: [{ id: "part-doc" }] }, { table: "document_versions", data: [storedVersion("part-doc", "part-version")] }]);
    const result = await importProjectEmail(retry.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "excluded" }, { status: "imported" }] });
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.commit).toHaveBeenCalledTimes(1); retry.done();
  });
  it("rejects a changed malformed raw body before any attachment fetch or document creation", async () => {
    const p = { ...preview, manifest: { messages: [parseEmail(partialSource("*"))], unavailable: [] } };
    mocks.message.mockResolvedValue(partialSource("!"));
    const body = { id: "body", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body" };
    const fake = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: body }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [{ ...body, status: "failed" }] }]);
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0].complete).toBe(false);
    expect(mocks.attachment).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });
  it("never downloads an invalid locator beside a valid independently identified attachment", async () => {
    const source = partialSource();
    const badPart = { filename: "bad.pdf", mimeType: "application/pdf", body: { size: 9, attachmentId: "bad/locator" } };
    const combined = { ...source, payload: { ...source.payload, parts: [...source.payload.parts, badPart] } };
    const m = parseEmail(combined), p = { ...preview, manifest: { messages: [m], unavailable: [] } };
    mocks.message.mockResolvedValue(combined); mocks.attachment.mockResolvedValue({ data: Buffer.from("%PDF-test").toString("base64url") }); mocks.commit.mockResolvedValue({ error: null });
    const body = { id: "body", status: "excluded", lease_id: null, message_id: "a1", part_key: "body", detail: m.bodyUnavailable };
    const part = { id: "part", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "0.1", reserved_document_id: "doc", version_id: "version" };
    const bad = { id: "bad", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "0.2" };
    const done = { ...part, status: "imported", document_id: "doc", import_preview_id: "preview", ...sourceIdentity("version") };
    const fake = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: body }, { rpc: "claim_project_email_item", data: part }, { rpc: "stage_project_email_item", data: true }, { rpc: "claim_project_email_item", data: bad }, { table: "project_email_items", op: "update", data: { id: "bad" } }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [body, done, { ...bad, status: "excluded", detail: m.parts[1].excluded }] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [storedVersion("doc", "version")] }]);
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "excluded" }, { status: "imported" }, { status: "excluded" }] });
    expect(mocks.attachment).toHaveBeenCalledExactlyOnceWith("a1", "attachment"); expect(mocks.upload).toHaveBeenCalledTimes(1); fake.done();
  });

  it("preserves rendered-text aggregate page limits when HTML expands beyond raw source bytes", async () => {
    const heading = `<h1>${"ΐ".repeat(1000)}</h1>`;
    const source = { ...raw, payload: { mimeType: "multipart/mixed", parts: [
      { mimeType: "text/html", body: { data: Buffer.from(heading).toString("base64url") } },
      { filename: "too-large.pdf", mimeType: "application/pdf", body: { size: 20 * 1024 * 1024 - 4000, attachmentId: "attachment" } },
    ] } };
    mocks.search.mockResolvedValue({ messages: [{ id: "a1" }] }); mocks.message.mockResolvedValue(source);
    const fake = scriptedDb([]);
    expect(await previewProjectEmail(fake.db, actor, { query: "a" })).toMatchObject({ ok: false, kind: "validation" });
    expect(mocks.upload).not.toHaveBeenCalled(); fake.done();
  });
  it.each(["id", "threadId"])("rejects a changed top-level %s despite an unchanged MIME fingerprint", async field => {
    mocks.message.mockResolvedValue({ ...raw, [field]: "different" });
    const body = { id: "body", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body" };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: body }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [{ ...body, status: "failed" }] }]);
    expect((await importProjectEmail(fake.db, actor, "preview", ["a1"])).ok).toBe(true);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); fake.done();
  });

  it("also requires fresh consent if an attachment-only preview unexpectedly becomes readable", async () => {
    const source = partialSource(Buffer.from("Readable body").toString("base64url"));
    const expected = { ...parseEmail(source), text: "", bodyUnavailable: "Previously unreadable body." };
    mocks.message.mockResolvedValue(source);
    const fake = scriptedDb([{ table: "project_email_previews", data: { ...preview, manifest: { messages: [expected], unavailable: [] } } }]);
    expect(await importProjectEmail(fake.db, actor, "preview", ["a1"])).toMatchObject({ ok: false, kind: "conflict" });
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.attachment).not.toHaveBeenCalled(); fake.done();
  });

  it("excludes a null-size PDF in preview and rejects an attachment-only selection with nothing eligible", async () => {
    const source = { ...raw, payload: { mimeType: "multipart/mixed", parts: [
      { mimeType: "text/plain", body: { data: "*" } },
      { filename: "invalid.pdf", mimeType: "application/pdf", body: { size: null, attachmentId: "invalid-size" } },
    ] } };
    mocks.search.mockResolvedValue({ messages: [{ id: "a1" }] }); mocks.message.mockResolvedValue(source);
    const search = scriptedDb([{ table: "project_email_items", data: [] }, { rpc: "create_project_email_preview" }]);
    const result = await previewProjectEmail(search.db, actor, { query: "a" });
    expect(result.ok && result.data.messages[0]).toMatchObject({ bodyUnavailable: expect.any(String), attachments: [{ name: "invalid.pdf", size: 0, excluded: "Attachment size metadata is invalid; not imported." }] });
    search.done();
    const p = { ...preview, manifest: { messages: [parseEmail(source)], unavailable: [] }, selected_ids: null, confirmed_at: null };
    const confirmation = scriptedDb([{ table: "project_email_previews", data: p }]);
    mocks.provider.mockClear();
    expect(await importProjectEmail(confirmation.db, actor, "preview", ["a1"])).toMatchObject({ ok: false, kind: "validation" });
    expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.attachment).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled(); confirmation.done();
  });

});
