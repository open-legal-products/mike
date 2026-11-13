import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { extractDocxBodyText, extractTrackedChangeIds } from "../../../lib/docxTrackedChanges";

const storage = vi.hoisted(() => ({
  downloadFile: vi.fn<(path: string) => Promise<ArrayBuffer | null>>(),
  uploadFile: vi.fn<(path: string, bytes: ArrayBuffer, contentType: string) => Promise<void>>(),
  deleteFile: vi.fn(),
  deleteFileBestEffort: vi.fn(),
  deleteFilesBestEffort: vi.fn(),
}));
const indexing = vi.hoisted(() => ({ processDocumentTextInline: vi.fn() }));
const logging = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("../../../lib/storage", () => storage);
vi.mock("../documents.indexing", () => indexing);
vi.mock("../../../lib/log", () => logging);

// Keep access, permissions, Supabase's query builders, and the DOCX matcher real.
import {
  DocumentReviewRetryableError,
  prepareDocumentReviewEdits,
  publishDocumentReview,
  type PreparedReviewEdits,
} from "../documents.reviewPublication";

type Row = Record<string, unknown>;
type RequestCall = {
  target: string;
  method: string;
  params: URLSearchParams;
  body: Row | undefined;
};
type Failure = { matches: (call: RequestCall) => boolean; message: string; code?: string };

/**
 * Real PostgREST builders, entirely local fetch. Apply every filter used by
 * these operations so a missing user/document/organization predicate cannot
 * accidentally be hidden by a canned response. This is not a SQL/RLS test.
 */
function database(options: { throwReadErrors?: boolean } = {}) {
  const rows: Record<string, Row[]> = {
    documents: [{
      id: "doc-1", user_id: "user-1", project_id: null, org_id: null,
      workflow_id: null, current_version_id: "version-1",
    }],
    document_versions: [{
      id: "version-1", document_id: "doc-1", storage_path: "source.docx",
      filename: "Original.docx", deleted_at: null, created_at: "2026-11-01T00:00:00Z",
    }],
    user_profiles: [{ user_id: "user-1", display_name: "Review Author", email: "author@example.test" }],
    projects: [], project_access_grants: [], organizations: [], org_members: [],
    project_org_access_overrides: [], workflows: [], workflow_shares: [],
    workflow_org_access_overrides: [], playbook_runs: [],
  };
  const calls: RequestCall[] = [];
  const failures: Failure[] = [];
  const rpcResults: Record<string, unknown> = {};
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const target = url.pathname.replace("/rest/v1/", "");
    const call: RequestCall = {
      target, method: init?.method ?? "GET", params: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) as Row : undefined,
    };
    calls.push(call);
    const failure = failures.find(({ matches }) => matches(call));
    if (failure) {
      return Response.json({ code: failure.code ?? "XX000", message: failure.message, details: null, hint: null }, { status: 400 });
    }
    if (target.startsWith("rpc/")) {
      if (!(target.slice(4) in rpcResults)) throw new Error(`Unexpected RPC: ${target}`);
      return Response.json(rpcResults[target.slice(4)]);
    }
    if (call.method !== "GET") throw new Error(`Unexpected table write: ${call.method} ${target}`);
    if (!(target in rows)) throw new Error(`Unexpected table: ${target}`);
    let selected = [...rows[target]];
    for (const [column, filter] of call.params) {
      if (column === "select" || column === "order" || column === "limit") continue;
      const dot = filter.indexOf(".");
      const operator = filter.slice(0, dot);
      const value = filter.slice(dot + 1);
      if (operator === "eq") selected = selected.filter(row => String(row[column]) === value);
      else if (operator === "is" && value === "null") selected = selected.filter(row => row[column] === null);
      else throw new Error(`Unsupported fixture filter: ${column}=${filter}`);
    }
    const order = call.params.get("order");
    if (order) {
      const [column, direction] = order.split(".");
      selected.sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (direction === "desc" ? -1 : 1));
    }
    const limit = call.params.get("limit");
    if (limit) selected = selected.slice(0, Number(limit));
    return Response.json(selected);
  });
  const db: Db = createClient("https://review.test", "unit-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  if (options.throwReadErrors) {
    type ReadBuilder = { throwOnError(): ReadBuilder };
    const client = db as unknown as { from(table: string): { select(...args: unknown[]): ReadBuilder } };
    const from = client.from.bind(client);
    client.from = (table: string) => {
      const query = from(table);
      const select = query.select.bind(query);
      query.select = (...args) => select(...args).throwOnError();
      return query;
    };
  }
  return { db, rows, calls, failures, rpcResults };
}
type Fixture = ReturnType<typeof database>;

const args = () => ({
  documentId: "doc-1", userId: "user-1", userEmail: "author@example.test",
  expectedVersion: { id: "version-1", storagePath: "source.docx" },
  edits: [{ findingIndex: 0, edit: edit("ten dollars", "twelve dollars") }],
});

function edit(find: string, replace: string) {
  return { find, replace, context_before: "", context_after: "", reason: `Replace ${find}` };
}

async function docx() {
  const zip = new JSZip();
  const paragraphs = [
    "The fee is ten dollars.", "Payment is due in 30 days.", "Confidential information remains protected.",
  ].map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphs}</w:body></w:document>`);
  return zip.generateAsync({ type: "arraybuffer" });
}

function project(fixture: Fixture, options: Row = {}) {
  Object.assign(fixture.rows.documents[0], { user_id: "other-user", project_id: "project-1" });
  fixture.rows.projects = [{
    id: "project-1", user_id: "other-user", org_id: null,
    visibility: "private", archived_at: null, ...options,
  }];
}

function membership(fixture: Fixture, role: string) {
  fixture.rows.organizations = [{ id: "org-1", kind: "team" }];
  fixture.rows.org_members = [{
    org_id: "org-1", user_id: "user-1", role, "organizations.deleted_at": null,
  }];
}

function cleanedUp(path: string) {
  expect(storage.deleteFileBestEffort).toHaveBeenCalledExactlyOnceWith(path, "playbook-review-unpublished");
  expect(storage.deleteFile).not.toHaveBeenCalled();
}

function noCleanup() {
  expect(storage.deleteFile).not.toHaveBeenCalled();
  expect(storage.deleteFileBestEffort).not.toHaveBeenCalled();
  expect(storage.deleteFilesBestEffort).not.toHaveBeenCalled();
}

async function expectRetryable(operation: Promise<unknown>, cause: { message: string }) {
  const failure: unknown = await operation.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DocumentReviewRetryableError);
  expect(failure).toMatchObject({ cause });
  return failure as DocumentReviewRetryableError;
}

/** Preparation runs before the RPC, so its failures are certain, not retryable. */
async function expectPrepareFailure(operation: Promise<unknown>, cause: { message: string }) {
  const failure: unknown = await operation.catch((error: unknown) => error);
  expect(failure).toMatchObject(cause);
  expect(failure).not.toBeInstanceOf(DocumentReviewRetryableError);
  return failure;
}

beforeEach(async () => {
  vi.resetAllMocks();
  storage.downloadFile.mockResolvedValue(await docx());
  storage.uploadFile.mockResolvedValue(undefined);
  indexing.processDocumentTextInline.mockResolvedValue(undefined);
});

describe("prepareDocumentReviewEdits", () => {
  it("prepares immutable DOCX bytes, exact successful finding links, and inherited filename without any database writes", async () => {
    const f = database();
    f.rows.document_versions.push({
      id: "version-2", document_id: "doc-1", filename: "  Renamed contract.docx  ",
      storage_path: "other.docx", deleted_at: null, created_at: "2026-11-02T00:00:00Z",
    });
    const input = {
      ...args(),
      edits: [
        { findingIndex: 7, edit: edit("Missing clause", "replacement") },
        { findingIndex: 2, edit: edit("30 days", "45 days") },
        { findingIndex: 8, edit: edit("", "") },
        { findingIndex: 0, edit: edit("ten dollars", "twelve dollars") },
        { findingIndex: 11, edit: edit("ten dollars", "twenty dollars") },
        { findingIndex: 4, edit: edit("", "unanchored insertion") },
        { findingIndex: 9, edit: edit("Confidential information remains protected.", "") },
      ],
    };
    const result = await prepareDocumentReviewEdits(f.db, input);
    expect(result).not.toBeNull();
    expect(result!.edits.map(change => [change.finding_index, change.deleted_text, change.inserted_text, change.reason])).toEqual([
      [2, "30", "45", "Replace 30 days"],
      [0, "en", "welve", "Replace ten dollars"],
      [9, "Confidential information remains protected.", "", "Replace Confidential information remains protected."],
    ]);
    expect(new Set(result!.edits.map(change => change.id)).size).toBe(3);
    expect(new Set(result!.edits.map(change => change.change_id)).size).toBe(3);
    expect(result!.edits[2]).toMatchObject({ del_w_id: expect.any(String), ins_w_id: null });
    expect(storage.uploadFile).toHaveBeenCalledTimes(1);
    const [path, bytes, mime] = storage.uploadFile.mock.calls[0];
    expect(path).toBe(`documents/user-1/doc-1/edits/${result!.version.id.replace(/-/g, "")}.docx`);
    expect(path).not.toBe(input.expectedVersion.storagePath);
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(result).toMatchObject({
      documentId: "doc-1", expectedVersion: input.expectedVersion,
      version: {
        storage_path: path, source: "assistant_edit", filename: "Renamed contract.docx", file_type: "docx",
        page_count: null, size_bytes: bytes.byteLength,
        content_sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
      },
    });
    expect(await extractDocxBodyText(Buffer.from(bytes))).toBe("The fee is twelve dollars.\nPayment is due in 45 days.\n");
    const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
    expect(xml).toContain('w:author="Review Author"');
    const ids = await extractTrackedChangeIds(Buffer.from(bytes));
    expect(ids.map(change => change.w_id).sort()).toEqual(result!.edits.flatMap(change => [change.del_w_id, change.ins_w_id]).filter(id => id !== null).sort());
    expect(storage.downloadFile).toHaveBeenCalledExactlyOnceWith("source.docx");
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    expect(f.calls.find(call => call.target === "document_versions" && call.params.has("id"))?.params.toString())
      .toContain("document_id=eq.doc-1");
    noCleanup();
  });

  it("returns a refusal without touching storage when there are no edits", async () => {
    const f = database();
    expect(await prepareDocumentReviewEdits(f.db, { ...args(), edits: [] })).toBeNull();
    expect(f.calls).toEqual([]);
    expect(storage.downloadFile).not.toHaveBeenCalled();
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it.each(["missing document", "new current version", "missing source", "wrong document", "deleted source", "changed path"])(
    "refuses %s rather than preparing against a different source",
    async (scenario) => {
      const f = database();
      if (scenario === "missing document") f.rows.documents = [];
      if (scenario === "new current version") f.rows.documents[0].current_version_id = "version-2";
      if (scenario === "missing source") f.rows.document_versions = [];
      if (scenario === "wrong document") f.rows.document_versions[0].document_id = "another-doc";
      if (scenario === "deleted source") f.rows.document_versions[0].deleted_at = "2026-11-07T00:00:00Z";
      if (scenario === "changed path") f.rows.document_versions[0].storage_path = "rewritten.docx";
      expect(await prepareDocumentReviewEdits(f.db, args())).toBeNull();
      expect(storage.downloadFile).not.toHaveBeenCalled();
      expect(storage.uploadFile).not.toHaveBeenCalled();
    },
  );

  it("returns a text-only refusal when all real matcher attempts fail", async () => {
    const f = database();
    expect(await prepareDocumentReviewEdits(f.db, {
      ...args(), edits: [{ findingIndex: 3, edit: edit("Absent clause", "replacement") }, { findingIndex: 8, edit: edit("", "") }],
    })).toBeNull();
    expect(storage.downloadFile).toHaveBeenCalledTimes(1);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it.each(["documents", "source version", "user_profiles", "filename"].flatMap(stage =>
    [false, true].map(throwReadErrors => ({ stage, throwReadErrors })),
  ))(
    "propagates a $stage database failure (throwOnError=$throwReadErrors) instead of reporting a matching/access refusal",
    async ({ stage, throwReadErrors }) => {
      const f = database({ throwReadErrors });
      f.failures.push({
        matches: call => stage === "source version" ? call.target === "document_versions" && call.params.has("id")
          : stage === "filename" ? call.target === "document_versions" && !call.params.has("id")
          : call.target === stage,
        message: `${stage} unavailable`,
      });
      await expectPrepareFailure(prepareDocumentReviewEdits(f.db, args()), { message: `${stage} unavailable` });
      expect(storage.uploadFile).not.toHaveBeenCalled();
      noCleanup();
    },
  );

  it.each(["download", "missing bytes", "invalid DOCX", "upload"])("propagates %s failures, deleting only an object the failed upload may have left", async (stage) => {
    const f = database();
    const failure = new Error(`${stage} unavailable`);
    if (stage === "download") storage.downloadFile.mockRejectedValue(failure);
    if (stage === "missing bytes") storage.downloadFile.mockResolvedValue(null);
    if (stage === "invalid DOCX") storage.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    if (stage === "upload") storage.uploadFile.mockRejectedValue(failure);
    if (stage === "download" || stage === "upload") {
      const thrown = await expectPrepareFailure(prepareDocumentReviewEdits(f.db, args()), { message: failure.message });
      expect(thrown).toBe(failure);
    } else if (stage === "missing bytes") {
      await expectPrepareFailure(prepareDocumentReviewEdits(f.db, args()), { message: "Review document bytes unavailable" });
    } else {
      const thrown: unknown = await prepareDocumentReviewEdits(f.db, args()).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(DocumentReviewRetryableError);
    }
    if (stage !== "upload") expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    if (stage === "upload") cleanedUp(storage.uploadFile.mock.calls[0][0]);
    else noCleanup();
  });
});

describe("review preparation uses actual document-edit permissions", () => {
  it.each(["editor", "viewer"])("normalizes authenticated email for a personal project %s grant", async (role) => {
    const f = database();
    project(f);
    f.rows.project_access_grants = [
      { project_id: "other-project", email: "recipient@example.test", role: "owner" },
      { project_id: "project-1", email: "someone-else@example.test", role: "owner" },
      { project_id: "project-1", email: "recipient@example.test", role },
    ];
    const result = await prepareDocumentReviewEdits(f.db, { ...args(), userEmail: "  Recipient@Example.TEST  " });
    expect(Boolean(result)).toBe(role === "editor");
    const grant = f.calls.find(call => call.target === "project_access_grants")!;
    expect(Object.fromEntries(grant.params)).toMatchObject({ project_id: "eq.project-1", email: "eq.recipient@example.test" });
    expect(storage.uploadFile).toHaveBeenCalledTimes(role === "editor" ? 1 : 0);
  });

  it("does not infer an email grant from the profile when authenticated email is absent", async () => {
    const f = database();
    project(f);
    f.rows.project_access_grants = [{ project_id: "project-1", email: "author@example.test", role: "editor" }];
    expect(await prepareDocumentReviewEdits(f.db, { ...args(), userEmail: null })).toBeNull();
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it("allows the personal project's owner to edit a different uploader's document", async () => {
    const f = database();
    project(f, { user_id: "user-1" });
    expect(await prepareDocumentReviewEdits(f.db, args())).not.toBeNull();
  });

  it("does not let a document's uploader bypass their inherited project viewer role", async () => {
    const f = database();
    project(f);
    f.rows.documents[0].user_id = "user-1";
    f.rows.project_access_grants = [{ project_id: "project-1", email: "author@example.test", role: "viewer" }];
    expect(await prepareDocumentReviewEdits(f.db, args())).toBeNull();
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it.each(["editor", "viewer"])("inherits a personal workflow's normalized-email %s share", async (role) => {
    const f = database();
    Object.assign(f.rows.documents[0], { user_id: "other-user", workflow_id: "workflow-1" });
    f.rows.workflows = [{ id: "workflow-1", user_id: "other-user", org_id: null, archived_at: null }];
    f.rows.workflow_shares = [{ workflow_id: "workflow-1", shared_with_email: "recipient@example.test", role }];
    const result = await prepareDocumentReviewEdits(f.db, { ...args(), userEmail: " Recipient@Example.TEST " });
    expect(Boolean(result)).toBe(role === "editor");
    expect(Object.fromEntries(f.calls.find(call => call.target === "workflow_shares")!.params))
      .toMatchObject({ workflow_id: "eq.workflow-1", shared_with_email: "eq.recipient@example.test" });
  });

  it.each(["project", "workflow"])("does not edit an archived %s even for its owner", async (kind) => {
    const f = database();
    if (kind === "project") project(f, { user_id: "user-1", archived_at: "2026-11-07T00:00:00Z" });
    else {
      f.rows.documents[0].workflow_id = "workflow-1";
      f.rows.workflows = [{ id: "workflow-1", user_id: "user-1", org_id: null, archived_at: "2026-11-07T00:00:00Z" }];
    }
    expect(await prepareDocumentReviewEdits(f.db, args())).toBeNull();
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it.each(["workflows", "workflow_shares"])("propagates %s access-read errors instead of silently refusing edits", async (target) => {
    const f = database();
    Object.assign(f.rows.documents[0], { user_id: "other-user", workflow_id: "workflow-1" });
    f.rows.workflows = [{ id: "workflow-1", user_id: "other-user", org_id: null, archived_at: null }];
    f.failures.push({ matches: call => call.target === target, message: `${target} unavailable` });
    await expectPrepareFailure(prepareDocumentReviewEdits(f.db, args()), { message: `${target} unavailable` });
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it.each([true, false])("requires current organization membership for a standalone uploader (member=%s)", async (member) => {
    const f = database();
    f.rows.documents[0].org_id = "org-1";
    membership(f, "member");
    if (!member) f.rows.org_members[0].user_id = "another-user";
    expect(Boolean(await prepareDocumentReviewEdits(f.db, args()))).toBe(member);
  });

  it("propagates a standalone uploader's organization lookup failure", async () => {
    const f = database();
    f.rows.documents[0].org_id = "org-1";
    f.failures.push({ matches: call => call.target === "organizations", message: "organization lookup unavailable" });
    await expectPrepareFailure(prepareDocumentReviewEdits(f.db, args()), { message: "organization lookup unavailable" });
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it("does not treat a deleted organization's membership as current", async () => {
    const f = database();
    f.rows.documents[0].org_id = "org-1";
    membership(f, "owner");
    f.rows.org_members[0]["organizations.deleted_at"] = "2026-11-07T00:00:00Z";
    expect(await prepareDocumentReviewEdits(f.db, args())).toBeNull();
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it("does not let a departed organization project creator fall back to a direct editor grant", async () => {
    const f = database();
    project(f, { org_id: "org-1", user_id: "user-1" });
    f.rows.project_access_grants = [{ project_id: "project-1", email: "author@example.test", role: "editor" }];
    expect(await prepareDocumentReviewEdits(f.db, args())).toBeNull();
    expect(f.calls.some(call => call.target === "project_access_grants")).toBe(false);
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it.each(["editor", "viewer", "deny"])("respects organization override %s on a public project", async (role) => {
    const f = database();
    project(f, { org_id: "org-1", visibility: "organization" });
    membership(f, "member");
    f.rows.project_org_access_overrides = [{ project_id: "project-1", org_id: "org-1", user_id: "user-1", role }];
    expect(Boolean(await prepareDocumentReviewEdits(f.db, args()))).toBe(role === "editor");
    expect(Object.fromEntries(f.calls.find(call => call.target === "project_org_access_overrides")!.params))
      .toMatchObject({ project_id: "eq.project-1", org_id: "eq.org-1", user_id: "eq.user-1" });
  });

  it.each([true, false])("grants an organization owner private-project edit rights only when it is ownerless (ownerless=%s)", async (ownerless) => {
    const f = database();
    project(f, { org_id: "org-1" });
    membership(f, "owner");
    f.rpcResults.org_item_is_ownerless = ownerless;
    f.rpcResults.org_private_access_role = "viewer";
    expect(Boolean(await prepareDocumentReviewEdits(f.db, args()))).toBe(ownerless);
    expect(f.calls.find(call => call.target === "rpc/org_item_is_ownerless")?.body)
      .toEqual({ p_kind: "project", p_item_id: "project-1" });
    if (!ownerless) expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it("keeps audited organization-owner access to another uploader's standalone document read-only", async () => {
    const f = database();
    Object.assign(f.rows.documents[0], { user_id: "other-user", org_id: "org-1" });
    membership(f, "owner");
    f.rpcResults.org_private_document_access = true;
    expect(await prepareDocumentReviewEdits(f.db, args())).toBeNull();
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });

  it.each(["projects", "project_access_grants", "org_members", "project_org_access_overrides", "rpc/org_item_is_ownerless", "rpc/org_private_access_role"])(
    "throws authorization IO errors from %s through real Supabase throwOnError",
    async (target) => {
      const f = database();
      project(f);
      if (target !== "projects" && target !== "project_access_grants") {
        f.rows.projects[0].org_id = "org-1";
        membership(f, "owner");
        f.rpcResults.org_item_is_ownerless = false;
        f.rpcResults.org_private_access_role = "viewer";
      }
      f.failures.push({ matches: call => call.target === target, message: `${target} unavailable` });
      await expectPrepareFailure(prepareDocumentReviewEdits(f.db, args()), { message: `${target} unavailable` });
      expect(f.calls.some(call => call.target === target)).toBe(true);
      expect(storage.downloadFile).not.toHaveBeenCalled();
      expect(storage.uploadFile).not.toHaveBeenCalled();
    },
  );

  it("throws an audited standalone access RPC error rather than permanently recording a text-only review", async () => {
    const f = database();
    Object.assign(f.rows.documents[0], { user_id: "other-user", org_id: "org-1" });
    f.failures.push({ matches: call => call.target === "rpc/org_private_document_access", message: "access unavailable" });
    await expectPrepareFailure(prepareDocumentReviewEdits(f.db, args()), { message: "access unavailable" });
    expect(storage.downloadFile).not.toHaveBeenCalled();
  });
});

function prepared(): PreparedReviewEdits {
  return {
    documentId: "doc-1", expectedVersion: { id: "version-1", storagePath: "source.docx" },
    version: {
      id: "new-version", storage_path: "new.docx", source: "assistant_edit", filename: "Contract.docx",
      file_type: "docx", size_bytes: 123, page_count: null, content_sha256: "a".repeat(64),
    },
    edits: [{
      id: "edit-1", finding_index: 2, change_id: "change-1", del_w_id: "1", ins_w_id: "2",
      deleted_text: "old", inserted_text: "new", context_before: "before", context_after: "after", reason: "Reason",
    }],
  };
}

const publicationArgs = () => ({
  runId: "run-1", userId: "user-1", summary: "Review complete",
  findings: [{ title: "No edit" }, { title: "Unmatched edit" }, { title: "Changed clause" }],
  prepared: prepared(),
});

const completedRun = () => ({
  id: "run-1", user_id: "user-1", status: "completed", edited_version_id: "saved-version",
  summary: "Saved summary", findings: [{ title: "Saved finding", edit_id: "saved-edit" }],
});

describe("publishDocumentReview", () => {
  it("sends the complete prepared version and finding mapping to the single publication RPC", async () => {
    const f = database();
    const run = completedRun();
    const input = publicationArgs();
    f.rpcResults.publish_playbook_review = { disposition: "published", run };
    expect(await publishDocumentReview(f.db, input)).toEqual({ disposition: "published", run });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      target: "rpc/publish_playbook_review", method: "POST",
      body: {
        p_run_id: "run-1", p_user_id: "user-1", p_summary: "Review complete", p_findings: input.findings,
        p_document_id: "doc-1", p_expected_version_id: "version-1", p_expected_storage_path: "source.docx",
        p_version: input.prepared.version, p_edits: input.prepared.edits,
      },
    });
    expect(indexing.processDocumentTextInline).toHaveBeenCalledExactlyOnceWith(f.db, ["saved-version"]);
    expect(storage.uploadFile).not.toHaveBeenCalled();
    noCleanup();
  });

  it("publishes text-only findings without inventing a version or edit mapping", async () => {
    const f = database();
    f.rpcResults.publish_playbook_review = { disposition: "published", run: { ...completedRun(), edited_version_id: null } };
    await publishDocumentReview(f.db, { ...publicationArgs(), prepared: null });
    expect(f.calls[0].body).toMatchObject({
      p_document_id: null, p_expected_version_id: null, p_expected_storage_path: null, p_version: null, p_edits: [],
    });
    expect(indexing.processDocumentTextInline).not.toHaveBeenCalled();
    noCleanup();
  });

  it.each(["source_changed", "existing", "missing", "terminal"])("returns the %s disposition and deletes the upload it proves unpublished", async (disposition) => {
    const f = database();
    f.rpcResults.publish_playbook_review = { disposition };
    expect(await publishDocumentReview(f.db, publicationArgs())).toEqual({ disposition });
    expect(indexing.processDocumentTextInline).not.toHaveBeenCalled();
    cleanedUp("new.docx");
  });

  it.each(["error", "empty response"])("reconciles an RPC %s with the completed persisted run, not the attempted edits", async (scenario) => {
    const f = database();
    if (scenario === "error") f.failures.push({ matches: call => call.target === "rpc/publish_playbook_review", message: "publication outcome unknown" });
    else f.rpcResults.publish_playbook_review = null;
    const run = completedRun();
    f.rows.playbook_runs = [
      { ...run, id: "another-run" }, { ...run, user_id: "another-user" }, run,
    ];
    expect(await publishDocumentReview(f.db, publicationArgs())).toEqual({ disposition: "existing", run });
    const read = f.calls.find(call => call.target === "playbook_runs")!;
    expect(Object.fromEntries(read.params)).toEqual({ select: "*", id: "eq.run-1", user_id: "eq.user-1" });
    expect(indexing.processDocumentTextInline).toHaveBeenCalledExactlyOnceWith(f.db, ["saved-version"]);
    noCleanup();
  });

  it.each(["running", "missing", "failed", "wrong owner", "failed reread", "rejected reread"])(
    "preserves an unknown RPC outcome when the reread is %s and never removes a possibly committed object",
    async (scenario) => {
      const f = database({ throwReadErrors: scenario === "rejected reread" });
      f.failures.push({ matches: call => call.target === "rpc/publish_playbook_review", message: "original publication failure" });
      if (scenario === "running" || scenario === "failed") f.rows.playbook_runs = [{ ...completedRun(), status: scenario }];
      if (scenario === "wrong owner") f.rows.playbook_runs = [{ ...completedRun(), user_id: "another-user" }];
      if (scenario === "failed reread" || scenario === "rejected reread") {
        f.failures.push({ matches: call => call.target === "playbook_runs", message: "secondary reread failure" });
      }
      await expectRetryable(publishDocumentReview(f.db, publicationArgs()), { message: "original publication failure" });
      expect(f.calls.map(call => call.target)).toEqual(["rpc/publish_playbook_review", "playbook_runs"]);
      expect(indexing.processDocumentTextInline).not.toHaveBeenCalled();
      noCleanup();
    },
  );

  it("does not report success when an empty RPC response is followed by a still-running run", async () => {
    const f = database();
    f.rpcResults.publish_playbook_review = null;
    f.rows.playbook_runs = [{ ...completedRun(), status: "running" }];
    await expectRetryable(publishDocumentReview(f.db, publicationArgs()), { message: "Review publication returned no result" });
    noCleanup();
  });

  it.each(["22023", "22P02", "23503", "23505", "P0002"])("keeps deterministic SQL %s failures terminal and deletes the rolled-back upload", async (code) => {
    const f = database();
    f.failures.push({ matches: call => call.target === "rpc/publish_playbook_review", message: "invalid publication input", code });
    const failure: unknown = await publishDocumentReview(f.db, publicationArgs()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code, message: "invalid publication input" });
    expect(failure).not.toBeInstanceOf(DocumentReviewRetryableError);
    expect(f.calls.map(call => call.target)).toEqual(["rpc/publish_playbook_review"]);
    expect(indexing.processDocumentTextInline).not.toHaveBeenCalled();
    cleanedUp("new.docx");
  });

  it.each(["08006", "40001", "40P01"])("marks unresolved SQL %s connection/concurrency failures retryable with their original cause", async (code) => {
    const f = database();
    f.failures.push({ matches: call => call.target === "rpc/publish_playbook_review", message: "transient publication failure", code });
    f.rows.playbook_runs = [{ ...completedRun(), status: "running" }];
    const failure = await expectRetryable(publishDocumentReview(f.db, publicationArgs()), { message: "transient publication failure" });
    expect(failure.cause).toMatchObject({ code });
    expect(f.calls.map(call => call.target)).toEqual(["rpc/publish_playbook_review", "playbook_runs"]);
    noCleanup();
  });

  it.each(["published", "existing", "reconciled"])("keeps the %s result when inline indexing fails, logging only safe diagnostics", async (scenario) => {
    const f = database();
    const run = completedRun();
    if (scenario === "reconciled") {
      f.failures.push({ matches: call => call.target === "rpc/publish_playbook_review", message: "publication unknown" });
      f.rows.playbook_runs = [run];
    } else f.rpcResults.publish_playbook_review = { disposition: scenario, run };
    indexing.processDocumentTextInline.mockRejectedValue(new Error("sensitive extractor detail"));
    expect(await publishDocumentReview(f.db, publicationArgs())).toEqual({ disposition: scenario === "published" ? "published" : "existing", run });
    expect(indexing.processDocumentTextInline).toHaveBeenCalledExactlyOnceWith(f.db, ["saved-version"]);
    expect(logging.logError).toHaveBeenCalledExactlyOnceWith("document-text", { category: "operation_failed" });
    if (scenario === "existing") cleanedUp("new.docx");
    else noCleanup();
  });
});
