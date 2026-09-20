import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => undefined),
  deleteFile: vi.fn(async () => undefined),
  headFile: vi.fn(async (): Promise<{ size: number; etag: string | null; contentType: string | null } | null> => null),
  storageEnabled: true,
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  get storageEnabled() {
    return mocks.storageEnabled;
  },
  uploadFile: mocks.uploadFile,
  copyFile: mocks.copyFile,
  deleteFile: mocks.deleteFile,
  headFile: mocks.headFile,
}));

import { attachDocxToReview, getReviewFileSource, isStashedDocxKey, parseCreateReviewBody, stashUploadedDocx } from "../contracts.service";

describe("stashUploadedDocx", () => {
  it("uploads under contracts/uploads/<uuid>.docx when storage is on", async () => {
    mocks.storageEnabled = true;
    const key = await stashUploadedDocx(Buffer.from("PK"));
    expect(isStashedDocxKey(key)).toBe(true);
    expect(mocks.uploadFile).toHaveBeenCalledWith(key, expect.any(ArrayBuffer), expect.stringContaining("wordprocessingml"));
  });

  it("returns null (HTML-only mode) when storage is not configured", async () => {
    mocks.storageEnabled = false;
    expect(await stashUploadedDocx(Buffer.from("PK"))).toBeNull();
    mocks.storageEnabled = true;
  });
});

describe("parseCreateReviewBody + contract_docx_path", () => {
  it("accepts only stashed keys and rejects arbitrary storage paths", () => {
    const ok = parseCreateReviewBody({ client_name: "A", contract_text: "x", contract_docx_path: "contracts/uploads/8f1e9a1c-2f4e-4b9a-9a1e-0c1d2e3f4a5b.docx" });
    expect(ok).toMatchObject({ ok: true, data: { contract_docx_path: expect.stringMatching(/^contracts\/uploads\//) } });
    expect(parseCreateReviewBody({ client_name: "A", contract_text: "x", contract_docx_path: "documents/other/user.docx" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseCreateReviewBody({ client_name: "A", contract_text: "x" })).toMatchObject({ ok: true, data: { contract_docx_path: null } });
  });
});

describe("attachDocxToReview", () => {
  it("copies to contracts/<reviewId>/original.docx, drops the stash, and records the path", async () => {
    const fake = scriptedDb([{ table: "reviews", op: "update", data: null }]);
    const r = await attachDocxToReview(fake.db as unknown as Db, { reviewId: "r1", stashedKey: "contracts/uploads/x.docx" });
    expect(r).toMatchObject({ ok: true, data: { contract_docx_path: "contracts/r1/original.docx" } });
    expect(mocks.copyFile).toHaveBeenCalledWith("contracts/uploads/x.docx", "contracts/r1/original.docx");
    expect(mocks.deleteFile).toHaveBeenCalledWith("contracts/uploads/x.docx");
    expect(fake.calls[0].payload).toEqual({ contract_docx_path: "contracts/r1/original.docx" });
    expect(fake.calls[0].filters).toEqual([["eq", "id", "r1"]]);
  });
});

describe("getReviewFileSource", () => {
  it("is not_found when the review has no persisted DOCX", async () => {
    const fake = scriptedDb([{ table: "reviews", data: { contract_docx_path: null, contract_filename: "a.docx", title: "t" } }]);
    const r = await getReviewFileSource(fake.db as unknown as Db, "r1");
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("returns the key, filename and size when persisted", async () => {
    mocks.headFile.mockResolvedValue({ size: 1234, etag: null, contentType: null });
    const fake = scriptedDb([{ table: "reviews", data: { contract_docx_path: "contracts/r1/original.docx", contract_filename: null, title: "PKS — A" } }]);
    const r = await getReviewFileSource(fake.db as unknown as Db, "r1");
    expect(r).toMatchObject({ ok: true, data: { key: "contracts/r1/original.docx", filename: "PKS — A.docx", size: 1234 } });
  });
});
