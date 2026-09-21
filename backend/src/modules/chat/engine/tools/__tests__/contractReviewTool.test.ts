import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../../../lib/supabase";
import type { DocIndex, DocStore } from "../../types";

const mocks = vi.hoisted(() => ({
  createReviewFromDocx: vi.fn(),
  executeReview: vi.fn(),
  summarizeReviewOutput: vi.fn(),
  loadCurrentVersionBytes: vi.fn(),
  downloadFile: vi.fn(),
}));
vi.mock("../../../../contracts/contracts.service", () => ({
  createReviewFromDocx: mocks.createReviewFromDocx,
  executeReview: mocks.executeReview,
  summarizeReviewOutput: mocks.summarizeReviewOutput,
}));
vi.mock("../documentOps", () => ({ loadCurrentVersionBytes: mocks.loadCurrentVersionBytes }));
vi.mock("../../../../../lib/storage", () => ({ downloadFile: mocks.downloadFile }));

import { CONTRACT_REVIEW_TOOLS, runContractReviewTool } from "../contractReviewTool";

const DB = {} as Db;
const BYTES = Buffer.from("PK");

function stores(fileType = "docx"): { docStore: DocStore; docIndex: DocIndex } {
  const docStore: DocStore = new Map([
    ["doc-0", { storage_path: "documents/abc/v1.docx", file_type: fileType, filename: `PKS Markas Daging.${fileType}` }],
  ]);
  const docIndex: DocIndex = { "doc-0": { document_id: "doc-uuid", filename: `PKS Markas Daging.${fileType}`, version_id: "ver-1" } };
  return { docStore, docIndex };
}

function frames(write: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return write.mock.calls.map(([line]) => JSON.parse(String(line).replace(/^data: /, "")));
}

describe("review_contract tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCurrentVersionBytes.mockResolvedValue({ bytes: BYTES, storage_path: "documents/abc/v1.docx" });
    mocks.createReviewFromDocx.mockResolvedValue({
      ok: true,
      data: { id: "rev-1", input: { contract_text: "T", client_name: "PT Markas Daging", document_type: "PKS", project_context: "", review_focus: ["Menyeluruh"] } },
    });
    mocks.executeReview.mockResolvedValue({
      ok: true,
      data: { review_id: "rev-1", risk_level: "CRITICAL", recommendation: "ESCALATE_TO_CEO_COO", ai_output: { risk_level: "CRITICAL" } },
    });
    mocks.summarizeReviewOutput.mockReturnValue({ risk_level: "CRITICAL", counts: { red_flags: 4 }, red_flags: [] });
  });

  it("advertises one tool that requires the document and the client name", () => {
    expect(CONTRACT_REVIEW_TOOLS).toHaveLength(1);
    expect(CONTRACT_REVIEW_TOOLS[0].function.name).toBe("review_contract");
    expect(CONTRACT_REVIEW_TOOLS[0].function.parameters.required).toEqual(["doc_id", "client_name"]);
  });

  it("runs the review from the attached DOCX and reports the workspace link", async () => {
    const write = vi.fn();
    const { docStore, docIndex } = stores();

    const result = await runContractReviewTool({
      args: { doc_id: "doc-0", client_name: "PT Markas Daging", document_type: "NDA", review_focus: ["Pembayaran", 7] },
      docStore,
      docIndex,
      userId: "u1",
      db: DB,
      write,
      nonce: "n0nce",
    });

    expect(mocks.loadCurrentVersionBytes).toHaveBeenCalledWith("doc-uuid", DB, "ver-1");
    expect(mocks.createReviewFromDocx).toHaveBeenCalledWith(DB, {
      userId: "u1",
      buffer: BYTES,
      filename: "PKS Markas Daging.docx",
      client_name: "PT Markas Daging",
      document_type: "NDA",
      project_context: "",
      review_focus: ["Pembayaran"],
    });
    expect(mocks.executeReview).toHaveBeenCalledWith(DB, "rev-1", expect.objectContaining({ client_name: "PT Markas Daging" }));

    const events = frames(write);
    expect(events[0]).toEqual({ type: "contract_review_start", filename: "PKS Markas Daging.docx" });
    expect(events[1]).toMatchObject({
      type: "contract_review",
      review_id: "rev-1",
      status: "ai_reviewed",
      risk_level: "CRITICAL",
      recommendation: "ESCALATE_TO_CEO_COO",
      workspace_path: "/contracts/rev-1",
      title: "PKS Markas Daging",
    });
    expect(result.event).toEqual(events[1]);
    expect(result.content).toContain("Bahasa Indonesia");
    const json = JSON.parse(result.content.split("\n\n")[1]);
    expect(json).toMatchObject({ review_id: "rev-1", workspace_path: "/contracts/rev-1", doc_id: "doc-0", risk_level: "CRITICAL" });
  });

  it("defaults the document type to PKS and falls back to the stored file when no version exists", async () => {
    mocks.loadCurrentVersionBytes.mockResolvedValue(null);
    mocks.downloadFile.mockResolvedValue(new Uint8Array(BYTES).buffer);
    const { docStore, docIndex } = stores();

    await runContractReviewTool({ args: { doc_id: "doc-0", client_name: "X", document_type: "Bogus" }, docStore, docIndex, userId: "u1", db: DB, write: vi.fn() });

    expect(mocks.downloadFile).toHaveBeenCalledWith("documents/abc/v1.docx");
    expect(mocks.createReviewFromDocx).toHaveBeenCalledWith(DB, expect.objectContaining({ document_type: "PKS", review_focus: ["Menyeluruh"] }));
  });

  it("answers 'Document not found.' for an unknown label without starting anything", async () => {
    const { docStore, docIndex } = stores();
    const write = vi.fn();
    const result = await runContractReviewTool({ args: { doc_id: "doc-7", client_name: "X" }, docStore, docIndex, userId: "u1", db: DB, write });
    expect(result).toEqual({ content: "Document not found.", event: null });
    expect(write).not.toHaveBeenCalled();
    expect(mocks.createReviewFromDocx).not.toHaveBeenCalled();
  });

  it("refuses a non-DOCX attachment and tells the model to ask for the Word file", async () => {
    const { docStore, docIndex } = stores("pdf");
    const result = await runContractReviewTool({ args: { doc_id: "doc-0", client_name: "X" }, docStore, docIndex, userId: "u1", db: DB, write: vi.fn() });
    expect(JSON.parse(result.content)).toMatchObject({ error: "unsupported_format" });
    expect(result.event).toBeNull();
    expect(mocks.loadCurrentVersionBytes).not.toHaveBeenCalled();
  });

  it("asks for the client name when the model omits it", async () => {
    const { docStore, docIndex } = stores();
    const result = await runContractReviewTool({ args: { doc_id: "doc-0" }, docStore, docIndex, userId: "u1", db: DB, write: vi.fn() });
    expect(JSON.parse(result.content)).toMatchObject({ error: "missing_client_name" });
    expect(mocks.createReviewFromDocx).not.toHaveBeenCalled();
  });

  it("reports when the bytes cannot be read", async () => {
    mocks.loadCurrentVersionBytes.mockResolvedValue(null);
    mocks.downloadFile.mockResolvedValue(null);
    const { docStore, docIndex } = stores();
    const result = await runContractReviewTool({ args: { doc_id: "doc-0", client_name: "X" }, docStore, docIndex, userId: "u1", db: DB, write: vi.fn() });
    expect(result).toEqual({ content: "Document could not be read.", event: null });
  });

  it("emits a failed card when the review row cannot be created", async () => {
    mocks.createReviewFromDocx.mockResolvedValue({ ok: false, kind: "validation", detail: "Ekstraksi gagal — dokumen kosong." });
    const write = vi.fn();
    const { docStore, docIndex } = stores();
    const result = await runContractReviewTool({ args: { doc_id: "doc-0", client_name: "X" }, docStore, docIndex, userId: "u1", db: DB, write });
    const events = frames(write);
    expect(events[1]).toMatchObject({ type: "contract_review", status: "failed", review_id: null, workspace_path: null, error: "Ekstraksi gagal — dokumen kosong." });
    expect(JSON.parse(result.content)).toMatchObject({ error: "review_not_created" });
    expect(mocks.executeReview).not.toHaveBeenCalled();
  });

  it("emits a failed card that still links to the row when the AI run fails", async () => {
    mocks.executeReview.mockResolvedValue({ ok: false, kind: "error", error: new Error("boom") });
    const write = vi.fn();
    const { docStore, docIndex } = stores();
    const result = await runContractReviewTool({ args: { doc_id: "doc-0", client_name: "X" }, docStore, docIndex, userId: "u1", db: DB, write });
    const events = frames(write);
    expect(events[1]).toMatchObject({ type: "contract_review", status: "failed", review_id: "rev-1", workspace_path: "/contracts/rev-1" });
    expect(events[1].error).not.toContain("boom");
    expect(JSON.parse(result.content)).toMatchObject({ error: "review_failed", review_id: "rev-1" });
  });
});
