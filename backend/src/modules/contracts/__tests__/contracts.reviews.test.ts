import { describe, expect, it } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
  deleteReview,
  extractContract,
  getReviewStatus,
  isReviewOutput,
  parseCreateReviewBody,
} from "../contracts.service";

describe("parseCreateReviewBody", () => {
  it("rejects a missing client name and empty contract text", () => {
    expect(parseCreateReviewBody({ contract_text: "x" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseCreateReviewBody({ client_name: "A", contract_text: "   " })).toMatchObject({ ok: false, kind: "validation" });
  });

  it("defaults document_type to Other, derives the title, and drops non-string focus entries", () => {
    const r = parseCreateReviewBody({ client_name: " PT A ", contract_text: "body", review_focus: ["payment", 3, null] });
    expect(r).toMatchObject({
      ok: true,
      data: { client_name: "PT A", document_type: "Other", title: "Other — PT A", review_focus: ["payment"], contract_html: null },
    });
  });
});

describe("isReviewOutput", () => {
  it("accepts a ReviewOutput and rejects error passthroughs or shapeless objects", () => {
    expect(isReviewOutput({ risk_level: "HIGH" })).toBe(true);
    expect(isReviewOutput({ overall_recommendation: "DO_NOT_SIGN" })).toBe(true);
    expect(isReviewOutput({ error: "boom", risk_level: "HIGH" })).toBe(false);
    expect(isReviewOutput({ executive_summary: "only" })).toBe(false);
    expect(isReviewOutput(null)).toBe(false);
  });
});

describe("extractContract", () => {
  it("rejects non-DOCX filenames, empty bodies, and oversized files without touching mammoth", async () => {
    const small = Buffer.from("PK");
    expect(await extractContract({ buffer: small, filename: "contract.pdf" })).toMatchObject({ ok: false, kind: "validation" });
    expect(await extractContract({ buffer: Buffer.alloc(0), filename: "contract.docx" })).toMatchObject({ ok: false, kind: "validation" });
    expect(await extractContract({ buffer: Buffer.alloc(25 * 1024 * 1024 + 1), filename: "c.docx" })).toMatchObject({
      ok: false,
      kind: "validation",
      detail: "File terlalu besar. Maksimum 25MB.",
    });
  });

  it("returns an extraction failure for bytes that are not a DOCX", async () => {
    const r = await extractContract({ buffer: Buffer.from("not a zip"), filename: "c.docx" });
    expect(r.ok).toBe(false);
  });
});

describe("getReviewStatus", () => {
  it("maps a missing row to not_found", async () => {
    const fake = scriptedDb([{ table: "reviews", data: null }]);
    const r = await getReviewStatus(fake.db as unknown as Db, "missing");
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("deleteReview", () => {
  it("refuses a caller without the admin role before touching reviews", async () => {
    const fake = scriptedDb([{ table: "user_roles", data: null }]);
    const r = await deleteReview(fake.db as unknown as Db, { userId: "u1", reviewId: "r1" });
    expect(r).toMatchObject({ ok: false, kind: "forbidden" });
    expect(fake.calls.map((c) => c.table)).toEqual(["user_roles"]);
  });

  it("deletes by id for an admin", async () => {
    const fake = scriptedDb([
      { table: "user_roles", data: { role: "admin" } },
      { table: "reviews", op: "delete", data: null },
    ]);
    const r = await deleteReview(fake.db as unknown as Db, { userId: "u1", reviewId: "r1" });
    expect(r).toMatchObject({ ok: true });
    expect(fake.calls[1].filters).toEqual([["eq", "id", "r1"]]);
  });
});
