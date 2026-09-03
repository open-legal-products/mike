import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, eq, downloadFile, uploadFile, deleteFile, docxToPdf } =
  vi.hoisted(() => ({
    from: vi.fn(),
    eq: vi.fn(),
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    docxToPdf: vi.fn(),
  }));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({ from }),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "u1";
    next();
  },
}));

vi.mock("../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/storage")>();
  return {
    ...actual,
    downloadFile,
    uploadFile,
    deleteFile,
  };
});

vi.mock("../../lib/convert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/convert")>();
  return { ...actual, docxToPdf };
});

import { workflowAddonsRouter } from "../../modules/workflows/workflowAddons.routes";

function queryReturning(data: unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "order", "in"]) {
    query[method] = vi.fn(() => query);
  }
  query.eq = eq.mockImplementation(() => query);
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data, error: null }).then(resolve, reject);
  return query;
}

function singleQueryReturning(data: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "insert", "delete", "eq"]) {
    query[method] = vi.fn(() => query);
  }
  query.single = vi.fn(async () => ({ data, error: null }));
  query.maybeSingle = vi.fn(async () => ({ data, error: null }));
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data, error: null }).then(resolve, reject);
  return query;
}

const app = express();
app.use(express.json());
app.use("/workflow-addons", workflowAddonsRouter);

describe("workflow add-on catalog routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    downloadFile.mockResolvedValue(
      new TextEncoder().encode("reference").buffer,
    );
    uploadFile.mockResolvedValue(undefined);
    deleteFile.mockResolvedValue(undefined);
    docxToPdf.mockResolvedValue(Buffer.from("converted-pdf"));
  });

  it("lists only active add-ons and preserves the public addon_key field", async () => {
    from.mockImplementation((table: string) =>
      table === "mike_workflows"
        ? queryReturning([
            {
              id: "catalog-1",
              workflow_key: "design-partner-draft",
              title: "Design Partner Draft",
              type: "assistant",
              active: true,
            },
          ])
        : queryReturning([
            {
              id: "reference-1",
              mike_workflow_id: "catalog-1",
              filename: "Precedent.docx",
              file_type: "docx",
              size_bytes: 42,
              created_at: "2026-08-28T00:00:00.000Z",
            },
          ]),
    );

    const response = await request(app).get("/workflow-addons?type=assistant");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({
        id: "catalog-1",
        addon_key: "design-partner-draft",
        title: "Design Partner Draft",
      }),
    ]);
    expect(response.body[0]).not.toHaveProperty("workflow_key");
    expect(response.body[0].assets).toEqual([
      expect.objectContaining({
        id: "reference-1",
        filename: "Precedent.docx",
      }),
    ]);
    expect(eq).toHaveBeenCalledWith("distribution", "addon");
    expect(eq).toHaveBeenCalledWith("active", true);
    expect(eq).toHaveBeenCalledWith("type", "assistant");
  });

  it("copies catalog assets into documents and document versions when imported", async () => {
    const insertedDocuments: unknown[] = [];
    const insertedVersions: unknown[] = [];
    from.mockImplementation((table: string) => {
      if (table === "mike_workflows") {
        return singleQueryReturning({
          id: "catalog-1",
          title: "Design Partner Draft",
          type: "assistant",
          prompt_md: "Draft from the precedent.",
          columns_config: null,
          language: "English",
          practice: "General Transactions",
          jurisdictions: ["General"],
        });
      }
      if (table === "workflows") {
        return singleQueryReturning({
          id: "workflow-1",
          user_id: "u1",
          title: "Design Partner Draft",
          type: "assistant",
          prompt_md: "Draft from the precedent.",
          columns_config: null,
          language: "English",
          practice: "General Transactions",
          jurisdictions: ["General"],
          created_at: "2026-08-28T00:00:00.000Z",
        });
      }
      if (table === "mike_workflow_assets") {
        return queryReturning([
          {
            filename: "Precedent.docx",
            file_type: "docx",
            storage_path: "mike-workflows/catalog-1/precedent.docx",
            size_bytes: 9,
          },
        ]);
      }
      if (table === "documents") {
        const query = singleQueryReturning(null);
        query.insert = vi.fn((value: unknown) => {
          insertedDocuments.push(value);
          return query;
        });
        query.update = vi.fn(() => query);
        return query;
      }
      if (table === "document_versions") {
        const query = singleQueryReturning(null);
        query.insert = vi.fn((value: unknown) => {
          insertedVersions.push(value);
          return query;
        });
        return query;
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await request(app).post(
      "/workflow-addons/catalog-1/import",
    );

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(downloadFile).toHaveBeenCalledWith(
      "mike-workflows/catalog-1/precedent.docx",
    );
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(insertedDocuments).toEqual([
      expect.objectContaining({
        workflow_id: "workflow-1",
        user_id: "u1",
        library_kind: "workflow_asset",
      }),
    ]);
    expect(insertedVersions).toEqual([
      expect.objectContaining({
        filename: "Precedent.docx",
        file_type: "docx",
        version_number: 1,
        pdf_storage_path: expect.stringMatching(
          /^converted-pdfs\/u1\/.+\.pdf$/,
        ),
      }),
    ]);
    expect(docxToPdf).toHaveBeenCalledOnce();
  });

  it("streams an add-on asset and converts presentations for PdfView", async () => {
    from.mockImplementation((table: string) => {
      if (table === "mike_workflows") {
        return singleQueryReturning({
          id: "catalog-1",
          type: "assistant",
        });
      }
      if (table === "mike_workflow_assets") {
        return singleQueryReturning({
          id: "reference-1",
          filename: "Deck.pptx",
          file_type: "pptx",
          storage_path: "mike-workflows/catalog-1/deck.pptx",
        });
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await request(app).get(
      "/workflow-addons/catalog-1/assets/reference-1/display",
    );

    expect(response.status).toBe(200);
    expect(downloadFile).toHaveBeenCalledWith(
      "mike-workflows/catalog-1/deck.pptx",
    );
    expect(docxToPdf).toHaveBeenCalledTimes(1);
    expect(response.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(response.headers["content-disposition"]).toContain("Deck.pdf");
    expect(Buffer.from(response.body).toString()).toBe("converted-pdf");
  });
});
