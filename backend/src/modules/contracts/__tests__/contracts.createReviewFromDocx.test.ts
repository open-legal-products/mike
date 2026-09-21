import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockSupabase, resetSupabaseState, supabaseState } from "../../../__tests__/helpers/supabaseMock";
import type { Db } from "../../../lib/supabase";

const mocks = vi.hoisted(() => ({
  extractContract: vi.fn(),
  attachDocxBytesToReview: vi.fn(),
}));
vi.mock("../contracts.extract", () => ({ extractContract: mocks.extractContract }));
vi.mock("../contracts.files", () => ({
  attachDocxBytesToReview: mocks.attachDocxBytesToReview,
  isStashedDocxKey: () => false,
}));
vi.mock("../contracts.ai", () => ({ runContractReviewAi: vi.fn() }));
vi.mock("../contracts.context", () => ({ buildReviewContextFor: vi.fn() }));
vi.mock("../contracts.redline", () => ({ projectRevisions: vi.fn() }));
vi.mock("../../playbook/playbook.service", () => ({ listPromptRules: vi.fn() }));

import { createReviewFromDocx } from "../contracts.reviews";

const BUFFER = Buffer.from("PKdocx");
const BASE = {
  userId: "u1",
  buffer: BUFFER,
  filename: "PKS Markas Daging.docx",
  client_name: "PT Markas Daging",
  document_type: "PKS",
  project_context: "",
  review_focus: ["Menyeluruh"],
};

describe("createReviewFromDocx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSupabaseState();
    supabaseState.tables.reviews = { data: { id: "rev-9" }, error: null };
    mocks.extractContract.mockResolvedValue({
      ok: true,
      data: { contract_text: "TEKS", contract_html: "<p>TEKS</p>", filename: "PKS Markas Daging.docx" },
    });
    mocks.attachDocxBytesToReview.mockResolvedValue({ ok: true, data: { contract_docx_path: "contracts/rev-9/original.docx" } });
  });

  it("extracts, inserts the processing row, attaches the DOCX and returns the run input", async () => {
    const db = mockSupabase() as unknown as Db;
    const result = await createReviewFromDocx(db, BASE);

    expect(mocks.extractContract).toHaveBeenCalledWith({ buffer: BUFFER, filename: "PKS Markas Daging.docx" });
    expect(supabaseState.inserts[0]).toMatchObject({
      table: "reviews",
      payload: {
        user_id: "u1",
        title: "PKS Markas Daging",
        client_name: "PT Markas Daging",
        document_type: "PKS",
        contract_text: "TEKS",
        contract_html: "<p>TEKS</p>",
        contract_filename: "PKS Markas Daging.docx",
        review_focus: ["Menyeluruh"],
        status: "processing",
      },
    });
    expect(mocks.attachDocxBytesToReview).toHaveBeenCalledWith(db, { reviewId: "rev-9", buffer: BUFFER });
    expect(result).toEqual({
      ok: true,
      data: {
        id: "rev-9",
        input: { contract_text: "TEKS", client_name: "PT Markas Daging", document_type: "PKS", project_context: "", review_focus: ["Menyeluruh"] },
      },
    });
  });

  it("passes an extraction failure through untouched", async () => {
    mocks.extractContract.mockResolvedValue({ ok: false, kind: "validation", detail: "Hanya file DOCX yang diperbolehkan." });
    const result = await createReviewFromDocx(mockSupabase() as unknown as Db, { ...BASE, filename: "scan.pdf" });
    expect(result).toEqual({ ok: false, kind: "validation", detail: "Hanya file DOCX yang diperbolehkan." });
    expect(supabaseState.inserts).toEqual([]);
  });

  it("rejects an empty client name before touching the document", async () => {
    const result = await createReviewFromDocx(mockSupabase() as unknown as Db, { ...BASE, client_name: "  " });
    expect(result).toMatchObject({ ok: false, kind: "validation" });
    expect(mocks.extractContract).not.toHaveBeenCalled();
  });

  it("still returns the review when the DOCX cannot be persisted", async () => {
    mocks.attachDocxBytesToReview.mockResolvedValue({ ok: false, kind: "unavailable", detail: "no storage" });
    const result = await createReviewFromDocx(mockSupabase() as unknown as Db, BASE);
    expect(result.ok).toBe(true);
  });

  it("uses an explicit title when given", async () => {
    await createReviewFromDocx(mockSupabase() as unknown as Db, { ...BASE, title: "UJI ASSISTANT" });
    expect(supabaseState.inserts[0]).toMatchObject({ payload: { title: "UJI ASSISTANT" } });
  });
});
