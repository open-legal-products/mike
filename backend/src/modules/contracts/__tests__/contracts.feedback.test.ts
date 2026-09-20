import { describe, expect, it } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
  createComment,
  createFeedback,
  displayNameFromEmail,
  parseCommentBody,
  parseFeedbackBody,
  parseFeedbackBulkBody,
  parseMissedClauseBody,
  parseReviewPatch,
  saveClauseToLibrary,
  statusForStage,
  updateReviewMeta,
} from "../contracts.service";

describe("parseFeedbackBody", () => {
  it("accepts a plain valid action with no rationale", () => {
    const r = parseFeedbackBody({ finding_type: "red_flag", finding_id: "RF-001", action: "valid", original_severity: "HIGH" });
    expect(r).toMatchObject({ ok: true, data: { finding_type: "red_flag", finding_id: "RF-001", action: "valid" } });
  });

  it("requires a rationale for dismiss / reject / skip (also on the bulk path)", () => {
    for (const action of ["dismiss", "reject", "skip"]) {
      expect(parseFeedbackBody({ finding_type: "red_flag", finding_id: "RF-001", action })).toMatchObject({ ok: false, kind: "validation" });
    }
    expect(parseFeedbackBulkBody({ items: [{ finding_type: "revision", finding_id: "REV-001", action: "reject" }] })).toMatchObject({ ok: false, kind: "validation" });
  });

  it("requires edited_text for edit and an answer for answered", () => {
    expect(parseFeedbackBody({ finding_type: "revision", finding_id: "REV-001", action: "edit" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseFeedbackBody({ finding_type: "clarification", finding_id: "CLR-001", action: "answered" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseFeedbackBody({ finding_type: "clarification", finding_id: "CLR-001", action: "answered", rationale: "Sudah dikonfirmasi." })).toMatchObject({ ok: true });
  });

  it("rejects unknown actions and empty bulk payloads", () => {
    expect(parseFeedbackBody({ finding_type: "red_flag", finding_id: "RF-001", action: "approve" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseFeedbackBulkBody({ items: [] })).toMatchObject({ ok: false, kind: "validation" });
  });
});

describe("createFeedback", () => {
  it("writes the Janus row shape and only keeps edited_text for edit", async () => {
    const fake = scriptedDb([{ table: "review_feedback", op: "insert", data: { id: "f1" } }]);
    const parsed = parseFeedbackBody({
      finding_type: "revision",
      finding_id: "REV-001",
      action: "accept",
      original_text: "Rp 10.000.000",
      edited_text: "should be dropped",
      adjusted_severity: "",
    });
    if (!parsed.ok) throw new Error("parse failed");
    const r = await createFeedback(fake.db as unknown as Db, { reviewId: "r1", userId: "u1", input: parsed.data });
    expect(r).toMatchObject({ ok: true, data: { id: "f1" } });
    expect(fake.calls[0].payload).toEqual({
      review_id: "r1",
      user_id: "u1",
      finding_type: "revision",
      finding_id: "REV-001",
      action: "accept",
      original_severity: null,
      adjusted_severity: null,
      original_text: "Rp 10.000.000",
      edited_text: null,
      rationale: null,
    });
  });
});

describe("comments", () => {
  it("derives the display name from the email local part", () => {
    expect(displayNameFromEmail("aditya@dashelectric.co")).toBe("aditya");
    expect(displayNameFromEmail(undefined)).toBe("User");
  });

  it("stores suggested_text only for revision suggestions and supports replies", async () => {
    const fake = scriptedDb([{ table: "manual_comments", op: "insert", data: { id: "c1" } }]);
    const parsed = parseCommentBody({
      comment_type: "note",
      comment_text: "Perlu dicek",
      suggested_text: "ignored for notes",
      parent_comment_id: "8f1e9a1c-2f4e-4b9a-9a1e-0c1d2e3f4a5b",
    });
    if (!parsed.ok) throw new Error("parse failed");
    const r = await createComment(fake.db as unknown as Db, { reviewId: "r1", userId: "u1", userEmail: "robert@dash.co", input: parsed.data });
    expect(r).toMatchObject({ ok: true });
    expect(fake.calls[0].payload).toMatchObject({
      review_id: "r1",
      user_name: "robert",
      comment_type: "note",
      suggested_text: null,
      parent_comment_id: "8f1e9a1c-2f4e-4b9a-9a1e-0c1d2e3f4a5b",
    });
  });

  it("validates the missed-clause signal categories", () => {
    expect(parseMissedClauseBody({ highlight_text: "x", suggested_category: "typo", user_note: "n" })).toMatchObject({ ok: false });
    expect(parseMissedClauseBody({ highlight_text: "x", suggested_category: "missing_clause", user_note: "n" })).toMatchObject({ ok: true });
  });
});

describe("saveClauseToLibrary", () => {
  it("copies the review's client name and marks the source as clevel_approved", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: { client_name: "Markas Daging" } },
      { table: "clause_library", op: "insert", data: { id: "cl1" } },
    ]);
    const r = await saveClauseToLibrary(fake.db as unknown as Db, {
      reviewId: "r1",
      userId: "u1",
      input: { title: "Pasal 9 — Markas Daging", wording: "Batas tanggung jawab..." },
    });
    expect(r).toMatchObject({ ok: true, data: { id: "cl1" } });
    expect(fake.calls[1].payload).toMatchObject({
      source_type: "clevel_approved",
      source_review_id: "r1",
      source_client_name: "Markas Daging",
      approved_by: "u1",
    });
  });
});

describe("review metadata patch", () => {
  it("syncs the legacy status from the lifecycle stage", () => {
    expect(statusForStage("negotiation")).toBe("clevel_reviewed");
    expect(statusForStage("active")).toBe("signed");
    expect(statusForStage("draft")).toBeNull();
    expect(parseReviewPatch({ lifecycle_stage: "signed" })).toMatchObject({ ok: true, data: { lifecycle_stage: "signed", status: "signed" } });
  });

  it("rejects unknown keys, bad dates and empty patches", () => {
    expect(parseReviewPatch({ title: "x" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseReviewPatch({ expiry_date: "20/09/2026" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseReviewPatch({})).toMatchObject({ ok: false, kind: "validation" });
    expect(parseReviewPatch({ expiry_date: null, coo_recommendation_override: "DO_NOT_SIGN", coo_override_rationale: "risiko" })).toMatchObject({ ok: true });
  });

  it("updates by id and maps a missing review to not_found", async () => {
    const fake = scriptedDb([{ table: "reviews", op: "update", data: null }]);
    const r = await updateReviewMeta(fake.db as unknown as Db, { reviewId: "missing", patch: { status: "clevel_reviewed" } });
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
    expect(fake.calls[0].filters).toEqual([["eq", "id", "missing"]]);
  });
});
