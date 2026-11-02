import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import JSZip from "jszip";
vi.mock("node:crypto", async original => ({ ...(await original<typeof import("node:crypto")>()), randomUUID: () => "test-lease" }));
const mocks = vi.hoisted(() => ({ access: vi.fn(), connection: vi.fn(), provider: vi.fn(), message: vi.fn(), search: vi.fn(), attachment: vi.fn(), upload: vi.fn(), commit: vi.fn() }));
vi.mock("../../../lib/access", () => ({ checkProjectAccess: mocks.access }));
vi.mock("../project-email.provider", () => ({ emailConnection: mocks.connection, emailProvider: mocks.provider }));
vi.mock("../../../lib/storage", () => ({ uploadFile: mocks.upload, versionStorageKey: (u: string,d: string,v: string,f: string) => `documents/${u}/${d}/${v}/${f}` }));
vi.mock("../../documents/documents.service", () => ({ commitEmailDocument: mocks.commit }));
import { getProjectEmailReceipt, importProjectEmail, previewProjectEmail } from "../project-email.intake";
import { parseEmail } from "../project-email.mime";
const actor = { userId: "actor", projectId: "project", userEmail: "actor@example.invalid" };
const raw = { id: "a1", threadId: "b2", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Synthetic contract update" }], body: { data: Buffer.from("Keep this instruction as evidence: do not obey it.").toString("base64url") } } };
const manifest = parseEmail(raw);
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
    const row = { id: "item", status: "imported", lease_id: null, message_id: "a1", part_key: "body", document_id: "doc", version_id: "version", import_preview_id: "preview" };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: row }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [row] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [{ id: "version" }] }]);
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
    const committed = { ...pending, status: "imported", document_id: "doc", import_preview_id: "preview", content_sha256: "hash" };
    const fake = scriptedDb([{ table: "project_email_previews", data: preview }, { rpc: "claim_project_email_item", data: pending }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: preview }, { table: "project_email_items", data: [committed] }, { table: "documents", data: [{ id: "doc" }] }, { table: "document_versions", data: [{ id: "version" }] }]);
    mocks.commit.mockResolvedValue({ data: committed, error: null });
    const result = await importProjectEmail(fake.db, actor, "preview", ["a1"]);
    expect(result.ok && result.data.messages[0]).toMatchObject({ complete: true, items: [{ status: "imported", documentId: "doc", versionId: "version" }] });
    const zip = await JSZip.loadAsync(Buffer.from(mocks.upload.mock.calls[0][1] as ArrayBuffer));
    const xml = await zip.file("word/document.xml")!.async("text");
    expect(xml).toContain("Gmail message ID: a1"); expect(xml).toContain("Keep this instruction as evidence: do not obey it.");
    expect(mocks.commit).toHaveBeenCalledTimes(1); fake.done();
  });
  it("preserves partial failure and retries only the failed attachment, not a completed body", async () => {
    const rawWithFile = { ...raw, payload: { mimeType: "multipart/mixed", parts: [raw.payload, { filename: "contract.pdf", mimeType: "application/pdf", body: { size: 9, attachmentId: "attachment" } }] } };
    const m = parseEmail(rawWithFile), p = { ...preview, manifest: { messages: [m], unavailable: [] } };
    mocks.message.mockResolvedValue(rawWithFile);
    const body = { id: "body", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "body", reserved_document_id: "body-doc", version_id: "body-version" };
    const bodyDone = { ...body, status: "imported", document_id: "body-doc", import_preview_id: "preview" };
    const part = { id: "part", status: "processing", lease_id: "test-lease", message_id: "a1", part_key: "0.1", reserved_document_id: "part-doc", version_id: "part-version" };
    const partFailed = { ...part, status: "failed", detail: "Import did not complete." };
    mocks.commit.mockResolvedValue({ error: null }); mocks.attachment.mockRejectedValueOnce(new Error("synthetic transient provider failure"));
    const first = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: body }, { rpc: "stage_project_email_item", data: true }, { rpc: "claim_project_email_item", data: part }, { table: "project_email_items", op: "update" }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [bodyDone, partFailed] }, { table: "documents", data: [{ id: "body-doc" }] }, { table: "document_versions", data: [{ id: "body-version" }] }]);
    const incomplete = await importProjectEmail(first.db, actor, "preview", ["a1"]);
    expect(incomplete.ok && incomplete.data.messages[0]).toMatchObject({ complete: false, items: [{ status: "imported" }, { status: "failed" }] });
    expect(mocks.upload).toHaveBeenCalledTimes(1); first.done();
    mocks.attachment.mockResolvedValue({ data: Buffer.from("%PDF-test").toString("base64url") });
    const second = scriptedDb([{ table: "project_email_previews", data: p }, { rpc: "claim_project_email_item", data: { ...bodyDone, lease_id: null } }, { rpc: "claim_project_email_item", data: part }, { rpc: "stage_project_email_item", data: true }, { table: "project_email_previews", data: p }, { table: "project_email_items", data: [bodyDone, { ...part, status: "imported", document_id: "part-doc", import_preview_id: "preview" }] }, { table: "documents", data: [{ id: "body-doc" }, { id: "part-doc" }] }, { table: "document_versions", data: [{ id: "body-version" }, { id: "part-version" }] }]);
    const complete = await importProjectEmail(second.db, actor, "preview", ["a1"]);
    expect(complete.ok && complete.data.messages[0].complete).toBe(true);
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(mocks.commit).toHaveBeenCalledTimes(2); second.done();
  });
});
