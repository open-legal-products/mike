import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const {
  completeText,
  streamChatWithTools,
  getUserApiKeys,
  uploadFile,
  downloadFile,
  headFile,
  deleteFile,
  extractPdfTextForModel,
  extractDocxBodyText,
  getFileStreamSource,
} = vi.hoisted(() => ({
  completeText: vi.fn(),
  streamChatWithTools: vi.fn(),
  getUserApiKeys: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  headFile: vi.fn(),
  deleteFile: vi.fn(),
  extractPdfTextForModel: vi.fn(),
  extractDocxBodyText: vi.fn(),
  getFileStreamSource: vi.fn(),
}));
vi.mock("../../../lib/llm", async (original) => ({
  ...(await original<typeof import("../../../lib/llm")>()),
  completeText,
  streamChatWithTools,
}));
vi.mock("../../user/user.service", () => ({ getUserApiKeys }));
vi.mock("../../../lib/storage", async (original) => ({
  ...(await original<typeof import("../../../lib/storage")>()),
  uploadFile,
  downloadFile,
  headFile,
  deleteFile,
}));
vi.mock("../../../lib/pdfText", () => ({ extractPdfTextForModel }));
vi.mock("../../../lib/docxTrackedChanges", () => ({ extractDocxBodyText }));
vi.mock("../../documents/documents.service", () => ({ getFileStreamSource }));

import { blankPlaybookContent, reviewWithPlaybook } from "../playbooks.operations";
import {
  addPlaybookSourceFromDocument,
  addPlaybookSourceFromUpload,
  deletePlaybookSource,
  listPlaybookSources,
} from "../playbooks.sources";

type Row = Record<string, unknown>;

function book(overrides: Row = {}): Row {
  return {
    id: "book",
    user_id: "owner",
    org_id: null,
    visibility: "private",
    name: "Guide",
    description: "",
    content_json: blankPlaybookContent("Guide"),
    created_at: "2026-10-17",
    updated_at: "2026-10-17",
    ...overrides,
  };
}

function source(overrides: Row = {}): Row {
  return {
    id: "src-1",
    playbook_id: "book",
    filename: "Data policy.pdf",
    file_type: "pdf",
    size_bytes: 1200,
    storage_key: "playbooks/owner/book/sources/src-1.pdf",
    extracted_text: "Personal data stays in the EU.",
    text_length: 30,
    created_at: "2026-10-17T01:00:00.000Z",
    ...overrides,
  };
}

/** Applies filters, inserts and deletes, so tenant isolation is exercised. */
function database(tables: Record<string, Row[]>) {
  const all: Record<string, Row[]> = {
    org_members: [],
    user_profiles: [],
    playbook_runs: [],
    playbook_sources: [],
    playbook_org_access_overrides: [],
    playbook_shares: [
      { id: "share-1", playbook_id: "book", shared_with_email: "reader@example.com", role: "viewer" },
      { id: "share-2", playbook_id: "book", shared_with_email: "editor@example.com", role: "editor" },
    ],
    ...tables,
  };
  const from = (table: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    let op = "select";
    let payload: Row = {};
    const settle = () => {
      const matches = (all[table] ?? []).filter((row) =>
        predicates.every((test) => test(row)),
      );
      if (op === "insert") {
        (all[table] ??= []).push(payload);
        return { data: [payload], error: null };
      }
      if (op === "update") matches.forEach((row) => Object.assign(row, payload));
      if (op === "delete")
        all[table] = (all[table] ?? []).filter((row) => !matches.includes(row));
      return { data: matches, error: null };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        predicates.push((row) => row[key] === value);
        return query;
      },
      is: () => query,
      in: (key: string, values: unknown[]) => {
        predicates.push((row) => values.includes(row[key]));
        return query;
      },
      order: () => query,
      limit: () => query,
      insert: (value: Row) => {
        op = "insert";
        payload = value;
        return query;
      },
      update: (value: Row) => {
        op = "update";
        payload = value;
        return query;
      },
      delete: () => {
        op = "delete";
        return query;
      },
      maybeSingle: async () => ({
        data: settle().data[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve),
    };
    return query;
  };
  return { db: { from } as unknown as Db, tables: all };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserApiKeys.mockResolvedValue({ claude: "test-key" });
  uploadFile.mockResolvedValue(undefined);
  deleteFile.mockResolvedValue(undefined);
  headFile.mockResolvedValue({ size: 1200, etag: null, contentType: null });
  downloadFile.mockResolvedValue(new ArrayBuffer(1200));
  extractPdfTextForModel.mockResolvedValue("Retention: seven years.\u0000");
  extractDocxBodyText.mockResolvedValue("Template clause text.");
  completeText.mockResolvedValue(
    JSON.stringify({ summary: "Reviewed", findings: [] }),
  );
});

describe("listing supplementary documents", () => {
  it("shows them to anyone who can view the playbook, without storage keys", async () => {
    const { db } = database({ playbooks: [book()], playbook_sources: [source()] });
    const listed = await listPlaybookSources("reader", "book", db, "reader@example.com");
    expect(listed).toEqual([
      {
        id: "src-1",
        filename: "Data policy.pdf",
        fileType: "pdf",
        sizeBytes: 1200,
        createdAt: "2026-10-17T01:00:00.000Z",
      },
    ]);
  });

  it("hides them from someone who cannot view the playbook", async () => {
    const { db } = database({ playbooks: [book()], playbook_sources: [source()] });
    await expect(
      listPlaybookSources("stranger", "book", db, "stranger@example.com"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/** A key shaped exactly as the upload-URL route mints it. */
function staged(userId: string): string {
  return `playbooks/${userId}/source-uploads/11111111-2222-4333-8444-555555555555.pdf`;
}

describe("adding supplementary documents", () => {
  it("copies a staged upload into the playbook with its text", async () => {
    const { db, tables } = database({ playbooks: [book()] });
    const added = await addPlaybookSourceFromUpload(
      "owner",
      "owner@example.com",
      "book",
      {
        storageKey: staged("owner"),
        filename: "Retention policy.pdf",
      },
      db,
    );
    expect(added).toMatchObject({ filename: "Retention policy.pdf", fileType: "pdf" });
    const row = tables.playbook_sources[0];
    expect(row).toMatchObject({
      playbook_id: "book",
      file_type: "pdf",
      extracted_text: "Retention: seven years.",
      text_length: 23,
      created_by: "owner",
    });
    expect(row.storage_key).toBe(`playbooks/owner/book/sources/${added.id}.pdf`);
    expect(uploadFile).toHaveBeenCalledWith(
      row.storage_key,
      expect.any(ArrayBuffer),
      "application/pdf",
    );
  });

  it("refuses an upload staged under another account", async () => {
    const { db, tables } = database({ playbooks: [book()] });
    await expect(
      addPlaybookSourceFromUpload(
        "owner",
        "owner@example.com",
        "book",
        { storageKey: staged("someone"), filename: "x.pdf" },
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(tables.playbook_sources).toHaveLength(0);
  });

  it("refuses a staged key that traverses out of the caller's prefix", async () => {
    const { db, tables } = database({ playbooks: [book()] });
    await expect(
      addPlaybookSourceFromUpload(
        "owner",
        "owner@example.com",
        "book",
        {
          storageKey:
            "playbooks/owner/source-uploads/../../../documents/victim/d1/source.pdf",
          filename: "x.pdf",
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(headFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(tables.playbook_sources).toHaveLength(0);
  });

  it("lets editors add documents but not viewers", async () => {
    const { db, tables } = database({ playbooks: [book()] });
    await expect(
      addPlaybookSourceFromUpload(
        "reader",
        "reader@example.com",
        "book",
        { storageKey: staged("reader"), filename: "x.pdf" },
        db,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(uploadFile).not.toHaveBeenCalled();

    await addPlaybookSourceFromUpload(
      "editor",
      "editor@example.com",
      "book",
      { storageKey: staged("editor"), filename: "x.pdf" },
      db,
    );
    // Stored under the creator's prefix, whoever added it.
    expect(tables.playbook_sources[0].storage_key).toMatch(
      /^playbooks\/owner\/book\/sources\//,
    );
    expect(tables.playbook_sources[0].created_by).toBe("editor");
  });

  it("stops at twenty documents", async () => {
    const { db } = database({
      playbooks: [book()],
      playbook_sources: Array.from({ length: 20 }, (_, i) =>
        source({ id: `src-${i}` }),
      ),
    });
    await expect(
      addPlaybookSourceFromUpload(
        "owner",
        "owner@example.com",
        "book",
        { storageKey: staged("owner"), filename: "x.pdf" },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("copies a library document only when the creator can open it", async () => {
    const { db, tables } = database({ playbooks: [book()] });
    getFileStreamSource.mockResolvedValueOnce({ ok: false, detail: "Document not found" });
    await expect(
      addPlaybookSourceFromDocument("owner", "owner@example.com", "book", "doc-x", db),
    ).rejects.toMatchObject({ status: 404 });

    getFileStreamSource.mockResolvedValueOnce({
      ok: true,
      storagePath: "documents/owner/doc-1/v1.docx",
      fileType: "docx",
      size: 1200,
      filename: "Standard template.docx",
    });
    const added = await addPlaybookSourceFromDocument(
      "owner",
      "owner@example.com",
      "book",
      "doc-1",
      db,
    );
    expect(getFileStreamSource).toHaveBeenLastCalledWith(
      "doc-1",
      "owner",
      "owner@example.com",
      null,
      db,
    );
    expect(downloadFile).toHaveBeenCalledWith("documents/owner/doc-1/v1.docx");
    expect(added).toMatchObject({ filename: "Standard template.docx", fileType: "docx" });
    expect(tables.playbook_sources[0]).toMatchObject({
      extracted_text: "Template clause text.",
    });
  });
});

describe("removing supplementary documents", () => {
  it("deletes the row and its stored file", async () => {
    const { db, tables } = database({ playbooks: [book()], playbook_sources: [source()] });
    await deletePlaybookSource("owner", "owner@example.com", "book", "src-1", db);
    expect(tables.playbook_sources).toHaveLength(0);
    expect(deleteFile).toHaveBeenCalledWith("playbooks/owner/book/sources/src-1.pdf");
  });

  it("does not delete another playbook's document", async () => {
    const { db, tables } = database({
      playbooks: [book(), book({ id: "other" })],
      playbook_sources: [source({ playbook_id: "other" })],
    });
    await expect(
      deletePlaybookSource("owner", "owner@example.com", "book", "src-1", db),
    ).rejects.toMatchObject({ status: 404 });
    expect(tables.playbook_sources).toHaveLength(1);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe("reviews with supplementary documents", () => {
  it("lists the documents and lets the model read one by id", async () => {
    const { db } = database({
      playbooks: [book(), book({ id: "other" })],
      playbook_sources: [
        source(),
        source({ id: "foreign", playbook_id: "other", extracted_text: "Secret" }),
      ],
    });
    const toolResults: string[] = [];
    streamChatWithTools.mockImplementation(async (params) => {
      const prompt = params.messages[0].content as string;
      expect(prompt).toContain("id: src-1 | name: Data policy.pdf");
      expect(prompt).not.toContain("Personal data stays in the EU.");
      const results = await params.runTools([
        { id: "c1", name: "read_supplementary_document", input: { documentId: "src-1" } },
        { id: "c2", name: "read_supplementary_document", input: { documentId: "foreign" } },
      ]);
      toolResults.push(...results.map((result: { content: string }) => result.content));
      return { fullText: JSON.stringify({ summary: "Checked policy", findings: [] }) };
    });

    const result = await reviewWithPlaybook({
      userId: "reader",
      userEmail: "reader@example.com",
      playbookId: "book",
      documentText: "Contract",
      model: "claude-opus-5",
      reviewMode: "strict",
      db,
    });

    expect(result.summary).toBe("Checked policy");
    expect(completeText).not.toHaveBeenCalled();
    expect(toolResults[0]).toContain("Personal data stays in the EU.");
    expect(toolResults[1]).toMatch(/no supplementary document has that id/i);
    expect(toolResults[1]).not.toContain("Secret");
  });

  it("keeps the single-call review when there is nothing to read", async () => {
    const { db } = database({ playbooks: [book()] });
    await reviewWithPlaybook({
      userId: "owner",
      playbookId: "book",
      documentText: "Contract",
      model: "claude-opus-5",
      reviewMode: "strict",
      db,
    });
    expect(streamChatWithTools).not.toHaveBeenCalled();
    expect(completeText.mock.calls[0][0].user).not.toContain(
      "SUPPLEMENTARY DOCUMENTS",
    );
  });
});
