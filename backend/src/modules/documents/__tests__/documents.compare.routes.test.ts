// HTTP boundary for version comparison, end to end inside the process: the
// real route, service, version lookup and Docxodus engine, over an in-memory
// database and object store holding real .docx files.
import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agreementDocx, ORIGINAL_CLAUSES, REVISED_CLAUSES } from "../../../__tests__/helpers/docxFixtures";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { extractDocxBodyText } from "../../../lib/docxTrackedChanges";

const state = vi.hoisted(() => ({
  db: null as unknown,
  objects: new Map<string, Buffer>(),
  readable: new Set<string>(["doc"]),
}));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => state.db }));
vi.mock("../../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.userId = "reader";
    res.locals.userEmail = "reader@example.com";
    next();
  },
}));
vi.mock("../documents.access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documents.access")>()),
  ensureDocumentAccess: async (documentId: string) => state.readable.has(documentId)
    ? { ok: true, doc: { id: documentId }, isCreator: false, projectRole: "viewer" }
    : { ok: false, kind: "forbidden" },
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  downloadFile: async (key: string) => {
    const bytes = state.objects.get(key);
    return bytes ? Uint8Array.from(bytes).buffer : null;
  },
}));
import { documentsRouter } from "../documents.routes";

const app = express();
app.use("/single-documents", documentsRouter);
const binary = (res: request.Response, done: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};
const compare = (query: string, documentId = "doc") =>
  request(app).get(`/single-documents/${documentId}/versions/compare?${query}`);

beforeAll(async () => {
  const row = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
    id, document_id: "doc", version_number: n, storage_path: `doc/${id}`, filename: "MSA.docx",
    file_type: "docx", size_bytes: 9000, deleted_at: null, ...extra,
  });
  state.db = tableDb({
    documents: [{ id: "doc", current_version_id: "v2" }, { id: "secret", current_version_id: "s1" }],
    document_versions: [
      row("v1", 1), row("v2", 2),
      row("v3", 3, { filename: "MSA.pdf", file_type: "pdf" }),
      row("v4", 4),
      row("s1", 1, { document_id: "secret", storage_path: "secret/s1" }),
    ],
  }).db;
  state.objects.set("doc/v1", await agreementDocx(ORIGINAL_CLAUSES));
  state.objects.set("doc/v2", await agreementDocx(REVISED_CLAUSES));
  state.objects.set("doc/v4", Buffer.from("this upload was never a Word document"));
  state.objects.set("secret/s1", await agreementDocx(["Confidential settlement terms."]));
}, 60_000);

describe("GET /single-documents/:documentId/versions/compare", () => {
  it("returns a redline .docx a viewer can open, named for the two versions", async () => {
    const response = await compare("base=v1&target=v2").buffer(true).parse(binary).expect(200);
    expect(response.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(response.headers["content-disposition"]).toContain("MSA (V1 to V2 comparison).docx");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(Number(response.headers["content-length"])).toBe(response.body.length);
    expect(response.body.subarray(0, 2).toString()).toBe("PK");
    expect(await extractDocxBodyText(response.body)).toBe(await extractDocxBodyText(state.objects.get("doc/v2")!));
  });

  it("returns the change list and counts as JSON on request", async () => {
    const response = await compare("base=v1&target=v2&format=json").expect(200);
    expect(response.body).toMatchObject({
      engine: "docxodus",
      base: { id: "v1", version_number: 1 },
      target: { id: "v2", version_number: 2 },
      summary: { insertions: 2, deletions: 1, total: 3 },
    });
    expect(response.body.revisions.map((revision: { kind: string }) => revision.kind)).toEqual(["insert", "delete", "insert"]);
    expect(response.body.revisions[1]).toMatchObject({ kind: "delete", text: "thirty (30" });
  });

  it.each([
    ["the same version twice", "base=v1&target=v1", 400, "Choose two different versions to compare."],
    ["a missing target", "base=v1", 400, "base and target versions are required."],
    ["a repeated parameter", "base=v1&base=v2&target=v2", 400, "base and target versions are required."],
    ["a version that is not a Word document", "base=v1&target=v3", 400, "Only Word (.docx) versions can be compared."],
    ["an unknown version", "base=v1&target=missing", 404, "Version not found"],
    ["another document's version", "base=v1&target=s1", 404, "Version not found"],
    ["stored bytes that are not a Word document", "base=v1&target=v4", 422, "These versions could not be compared."],
  ])("rejects %s", async (_label, query, status, detail) => {
    const response = await compare(query).expect(status);
    expect(response.body).toEqual({ detail });
  });

  it("does not reveal a document the caller cannot read, or anything in it", async () => {
    const response = await compare("base=s1&target=v1", "secret").expect(404);
    expect(response.body).toEqual({ detail: "Document not found" });
    expect(JSON.stringify(response.body)).not.toContain("settlement");
  });
});
