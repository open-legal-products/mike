import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn(async () => new Uint8Array([80, 75]).buffer as ArrayBuffer),
  uploadFile: vi.fn(async () => undefined),
  applyTrackedEdits: vi.fn(),
  resolveTrackedChange: vi.fn(),
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  storageEnabled: true,
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
}));
vi.mock("../../../lib/docxTrackedChanges", () => ({
  applyTrackedEdits: mocks.applyTrackedEdits,
  resolveTrackedChange: mocks.resolveTrackedChange,
}));

import { cooAuthor, editRevision, projectRevisions, resolveRevision, revisionToEdit } from "../contracts.service";
import type { Revision } from "../contracts.types";

const REV: Revision = {
  id: "REV-001",
  clause: "Pasal 9",
  original_text: "Rp 50.000.000",
  suggested_text: "Rp 10.000.000",
  rationale: "Sesuai playbook.",
  priority: "MUST_CHANGE",
  from_clause_library: false,
  clause_library_source: null,
};
const REVIEW = {
  id: "r1",
  contract_docx_path: "contracts/r1/original.docx",
  contract_redline_path: null,
  contract_text: "Batas tanggung jawab tahunan sebesar Rp 50.000.000 untuk pengiriman roda dua.",
  ai_output: { revisions: [REV, { ...REV, id: "REV-002", original_text: "teks yang tidak ada" }] },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revisionToEdit", () => {
  it("anchors on original_text with surrounding context from the contract text", () => {
    const edit = revisionToEdit(REV, REVIEW.contract_text);
    expect(edit).toMatchObject({ find: "Rp 50.000.000", replace: "Rp 10.000.000", reason: "Sesuai playbook." });
    expect(edit.context_before).toBe("Batas tanggung jawab tahunan sebesar ");
    expect(edit.context_after).toBe(" untuk pengiriman roda dua.");
  });

  it("falls back to highlight_text and empty context when the text is not found", () => {
    const edit = revisionToEdit({ ...REV, original_text: "", highlight_text: "klausul X" }, "tidak ada");
    expect(edit).toMatchObject({ find: "klausul X", context_before: "", context_after: "" });
  });

  it("labels COO changes with the email local part", () => {
    expect(cooAuthor("robert@dashelectric.co")).toBe("robert (Tinjau COO Review)");
  });
});

describe("projectRevisions", () => {
  it("writes the redline copy, records ids for anchored revisions and errors for the rest", async () => {
    mocks.applyTrackedEdits.mockResolvedValue({
      bytes: Buffer.from("redlined"),
      changes: [{ id: "c1", delId: "7", insId: "8", deletedText: "Rp 50.000.000", insertedText: "Rp 10.000.000", contextBefore: "", contextAfter: "" }],
      errors: [{ index: 1, reason: "Text not found." }],
    });
    const fake = scriptedDb([
      { table: "reviews", data: REVIEW },
      { table: "review_revision_edits", data: [] },
      { table: "reviews", op: "update", data: null },
      { table: "review_revision_edits", op: "insert", data: [{ id: "e1", revision_id: "REV-001" }, { id: "e2", revision_id: "REV-002" }] },
    ]);

    const r = await projectRevisions(fake.db as unknown as Db, { reviewId: "r1" });

    expect(r).toMatchObject({ ok: true, data: { projected: 1, failed: 1, skipped: 0 } });
    expect(mocks.applyTrackedEdits).toHaveBeenCalledWith(expect.any(Buffer), [expect.objectContaining({ find: "Rp 50.000.000" }), expect.objectContaining({ find: "teks yang tidak ada" })], { author: "Tinjau (AI Suggestion)" });
    expect(mocks.uploadFile).toHaveBeenCalledWith("contracts/r1/redline.docx", expect.any(ArrayBuffer), expect.any(String));
    expect(fake.calls[2].payload).toEqual({ contract_redline_path: "contracts/r1/redline.docx" });
    const rows = fake.calls[3].payload as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ revision_id: "REV-001", change_id: "c1", del_w_id: "7", ins_w_id: "8", status: "pending", error: null });
    expect(rows[1]).toMatchObject({ revision_id: "REV-002", error: "Text not found." });
  });

  it("skips revisions that already have rows and does nothing when all are projected", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: REVIEW },
      { table: "review_revision_edits", data: [{ revision_id: "REV-001" }, { revision_id: "REV-002" }] },
    ]);
    const r = await projectRevisions(fake.db as unknown as Db, { reviewId: "r1" });
    expect(r).toMatchObject({ ok: true, data: { projected: 0, failed: 0, skipped: 2 } });
    expect(mocks.applyTrackedEdits).not.toHaveBeenCalled();
  });

  it("refuses when the review has no persisted DOCX", async () => {
    const fake = scriptedDb([{ table: "reviews", data: { ...REVIEW, contract_docx_path: null } }]);
    const r = await projectRevisions(fake.db as unknown as Db, { reviewId: "r1" });
    expect(r).toMatchObject({ ok: false, kind: "validation" });
  });
});

const EDIT_ROW = {
  id: "e1", review_id: "r1", revision_id: "REV-001", change_id: "c1", del_w_id: "7", ins_w_id: "8",
  deleted_text: "Rp 50.000.000", inserted_text: "Rp 10.000.000", author: "Tinjau (AI Suggestion)", status: "pending", error: null,
};

describe("resolveRevision", () => {
  it("accepts the change in the working copy and records feedback accept", async () => {
    mocks.resolveTrackedChange.mockResolvedValue({ bytes: Buffer.from("resolved"), found: true });
    const fake = scriptedDb([
      { table: "review_revision_edits", data: EDIT_ROW },
      { table: "reviews", data: { ...REVIEW, contract_redline_path: "contracts/r1/redline.docx" } },
      { table: "review_revision_edits", op: "update", data: { ...EDIT_ROW, status: "accepted" } },
      { table: "review_feedback", op: "insert", data: { id: "f1", action: "accept" } },
    ]);
    const r = await resolveRevision(fake.db as unknown as Db, { reviewId: "r1", revisionId: "REV-001", mode: "accept", userId: "u1" });
    expect(r).toMatchObject({ ok: true, data: { edit: { status: "accepted" }, feedback: { action: "accept" } } });
    expect(mocks.resolveTrackedChange).toHaveBeenCalledWith(expect.any(Buffer), ["7", "8"], "accept");
    expect(mocks.uploadFile).toHaveBeenCalledWith("contracts/r1/redline.docx", expect.any(ArrayBuffer), expect.any(String));
    expect(fake.calls[3].payload).toMatchObject({ finding_type: "revision", finding_id: "REV-001", action: "accept", original_text: "Rp 10.000.000" });
  });

  it("refuses card-only revisions (projection error) with conflict", async () => {
    const fake = scriptedDb([{ table: "review_revision_edits", data: { ...EDIT_ROW, change_id: null, error: "Text not found." } }]);
    const r = await resolveRevision(fake.db as unknown as Db, { reviewId: "r1", revisionId: "REV-001", mode: "reject", userId: "u1", rationale: "x" });
    expect(r).toMatchObject({ ok: false, kind: "conflict" });
  });
});

describe("editRevision", () => {
  it("rejects the AI change, applies the COO wording under the COO author, and records feedback edit", async () => {
    mocks.resolveTrackedChange.mockResolvedValue({ bytes: Buffer.from("rejected"), found: true });
    mocks.applyTrackedEdits.mockResolvedValue({
      bytes: Buffer.from("coo"),
      changes: [{ id: "c2", delId: "9", insId: "10", deletedText: "Rp 50.000.000", insertedText: "Rp 15.000.000", contextBefore: "", contextAfter: "" }],
      errors: [],
    });
    const fake = scriptedDb([
      { table: "review_revision_edits", data: EDIT_ROW },
      { table: "reviews", data: { ...REVIEW, contract_redline_path: "contracts/r1/redline.docx" } },
      { table: "review_revision_edits", op: "update", data: { ...EDIT_ROW, change_id: "c2", status: "accepted" } },
      { table: "review_feedback", op: "insert", data: { id: "f2", action: "edit" } },
    ]);
    const r = await editRevision(fake.db as unknown as Db, { reviewId: "r1", revisionId: "REV-001", editedText: "Rp 15.000.000", userId: "u1", userEmail: "robert@dash.co" });
    expect(r).toMatchObject({ ok: true, data: { edit: { change_id: "c2" }, feedback: { action: "edit" } } });
    expect(mocks.applyTrackedEdits).toHaveBeenCalledWith(expect.any(Buffer), [expect.objectContaining({ replace: "Rp 15.000.000" })], { author: "robert (Tinjau COO Review)" });
    expect(fake.calls[2].payload).toMatchObject({ change_id: "c2", del_w_id: "9", ins_w_id: "10", author: "robert (Tinjau COO Review)", status: "accepted" });
    expect(fake.calls[3].payload).toMatchObject({ action: "edit", edited_text: "Rp 15.000.000", original_text: "Rp 10.000.000" });
  });

  it("requires non-empty text", async () => {
    const fake = scriptedDb([]);
    const r = await editRevision(fake.db as unknown as Db, { reviewId: "r1", revisionId: "REV-001", editedText: "  ", userId: "u1" });
    expect(r).toMatchObject({ ok: false, kind: "validation" });
  });
});
