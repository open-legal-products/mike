import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserApiKeys, deleteFile, uploadFile } = vi.hoisted(() => ({
  getUserApiKeys: vi.fn(),
  deleteFile: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../../user/user.service", () => ({ getUserApiKeys }));
vi.mock("../../../lib/storage", () => ({ deleteFile, uploadFile }));

import {
  importPlaybookFromFile,
  startPlaybookImport,
} from "../playbooks.operations";

const MODEL = "claude-opus-5";

async function sourceDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Liability is capped at fees paid in the prior 12 months.</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function compiled(name: string): string {
  return JSON.stringify({
    name,
    description: "",
    representedParty: "Customer",
    documentTypes: [],
    jurisdictions: [],
    topics: [
      {
        name: "Liability",
        rules: [
          {
            name: "Liability cap",
            concept: "Determine whether liability is capped.",
            scope: "clause",
            required: true,
            guidance: "",
            standard: null,
            fallbacks: [],
            unacceptable: [],
            sourceRefs: ["P1"],
          },
        ],
      },
    ],
  });
}

/** Records every statement so the test can assert what the import wrote. */
function fakeDb(existing: Record<string, unknown> | null) {
  const calls: Array<{ table: string; op: string; values?: unknown }> = [];
  const from = (table: string) => {
    const state: { op: string; values?: unknown; columns?: string } = {
      op: "select",
    };
    const query: Record<string, unknown> = {};
    const settle = async () => {
      calls.push({ table, op: state.op, values: state.values });
      // A replacement's guarded update returns the row it matched; this
      // fake does not apply filters, so it always matches.
      if (state.op === "update" && table === "playbooks")
        return { data: existing ? [existing] : [], error: null };
      if (state.op !== "select") return { data: null, error: null };
      if (table === "playbooks") return { data: existing, error: null };
      return { data: null, error: null };
    };
    query.select = vi.fn((columns?: string) => {
      // A query starts as a select; after a write, select names the
      // columns the write returns and leaves it a write.
      state.columns = columns;
      return query;
    });
    for (const op of ["insert", "update", "delete"]) {
      query[op] = vi.fn((values?: unknown) => {
        state.op = op;
        state.values = values;
        return query;
      });
    }
    for (const op of ["eq", "in", "order", "limit"]) {
      query[op] = vi.fn(() => query);
    }
    query.single = vi.fn(settle);
    query.maybeSingle = vi.fn(settle);
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => settle().then(resolve, reject);
    return query;
  };
  return { db: { from } as never, calls };
}

const EXISTING = {
  id: "pb-1",
  user_id: "u1",
  name: "Commercial Playbook",
  description: "",
  status: "published",
  content_json: {
    name: "Commercial Playbook",
    description: "",
    representedParty: "Customer",
    documentTypes: [],
    jurisdictions: [],
    topics: [
      {
        id: "t1",
        name: "Liability",
        rules: [
          {
            id: "t1-r1",
            name: "Liability cap",
            concept: "Old concept.",
            scope: "clause",
            required: true,
            guidance: "",
            standard: null,
            fallbacks: [],
            unacceptable: [],
            sourceRefs: [],
          },
        ],
      },
    ],
  },
  source_filename: "old.docx",
  source_storage_key: "playbooks/u1/pb-1/source-old.docx",
  import_model: MODEL,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("replacing a playbook from a Word file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserApiKeys.mockResolvedValue({ claude: "sk-ant-test" });
    uploadFile.mockResolvedValue(undefined);
    deleteFile.mockResolvedValue(undefined);
  });

  it("rewrites the existing content instead of adding a playbook", async () => {
    const { db, calls } = fakeDb(EXISTING);

    await importPlaybookFromFile({
      userId: "u1",
      filename: "new.docx",
      buffer: await sourceDocx(),
      model: MODEL,
      playbookId: "pb-1",
      db,
      dependencies: {
        completeText: vi
          .fn()
          .mockResolvedValue(compiled("Commercial Playbook")),
      },
    });

    const writes = calls.filter((call) => call.table === "playbooks");
    expect(writes.some((call) => call.op === "insert")).toBe(false);

    const update = writes.find((call) => call.op === "update");
    expect(update).toBeDefined();
    const values = update?.values as Record<string, unknown>;
    expect(values).not.toHaveProperty("status");
    expect(values.source_filename).toBe("new.docx");
    // A replacement does not reintroduce publishing or change the row's age.
    expect(values).not.toHaveProperty("published_version_id");
    expect(values).not.toHaveProperty("created_at");
  });

  it("removes the superseded source file", async () => {
    const { db } = fakeDb(EXISTING);

    await importPlaybookFromFile({
      userId: "u1",
      filename: "new.docx",
      buffer: await sourceDocx(),
      model: MODEL,
      playbookId: "pb-1",
      db,
      dependencies: {
        completeText: vi
          .fn()
          .mockResolvedValue(compiled("Commercial Playbook")),
      },
    });

    expect(deleteFile).toHaveBeenCalledWith(EXISTING.source_storage_key);
    // The new object is written under a key of its own, so the current
    // source survives until the row update commits.
    const [newKey] = uploadFile.mock.calls[0] as [string];
    expect(newKey).not.toBe(EXISTING.source_storage_key);
    expect(newKey.startsWith("playbooks/u1/pb-1/")).toBe(true);
  });

  it("keeps the existing name when the caller sends none", async () => {
    const { db, calls } = fakeDb(EXISTING);

    await importPlaybookFromFile({
      userId: "u1",
      filename: "new.docx",
      buffer: await sourceDocx(),
      model: MODEL,
      playbookId: "pb-1",
      db,
      dependencies: {
        completeText: vi
          .fn()
          .mockResolvedValue(compiled("Commercial Playbook")),
      },
    });

    const update = calls.find(
      (call) => call.table === "playbooks" && call.op === "update",
    );
    expect((update?.values as Record<string, unknown>).name).toBe(
      "Commercial Playbook",
    );
  });

  it("refuses a playbook the caller does not own, before it calls a model", async () => {
    const { db } = fakeDb(null);
    const completeText = vi.fn();

    await expect(
      importPlaybookFromFile({
        userId: "u1",
        filename: "new.docx",
        buffer: await sourceDocx(),
        model: MODEL,
        playbookId: "pb-someone-else",
        db,
        dependencies: { completeText },
      }),
    ).rejects.toThrow(/not found/i);

    expect(completeText).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("still creates a playbook when no playbookId is given", async () => {
    const { db, calls } = fakeDb(EXISTING);

    await importPlaybookFromFile({
      userId: "u1",
      filename: "new.docx",
      buffer: await sourceDocx(),
      model: MODEL,
      db,
      dependencies: {
        completeText: vi.fn().mockResolvedValue(compiled("New Playbook")),
      },
    });

    const writes = calls.filter((call) => call.table === "playbooks");
    expect(writes.some((call) => call.op === "insert")).toBe(true);
    expect(writes.some((call) => call.op === "update")).toBe(false);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe("compiling an import apart from the request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserApiKeys.mockResolvedValue({ claude: "sk-ant-test" });
    uploadFile.mockResolvedValue(undefined);
    deleteFile.mockResolvedValue(undefined);
  });

  it("returns the running attempt before the model answers", async () => {
    const { db, calls } = fakeDb(EXISTING);
    let answer!: (raw: string) => void;
    const completeText = vi.fn(
      () => new Promise<string>((resolve) => (answer = resolve)),
    );

    const { attempt, done } = await startPlaybookImport({
      userId: "u1",
      filename: "Standards.docx",
      buffer: await sourceDocx(),
      model: MODEL,
      db,
      dependencies: { completeText },
    });

    expect(attempt).toMatchObject({
      status: "running",
      filename: "Standards.docx",
      playbookId: null,
    });
    expect(
      calls.some((call) => call.table === "playbooks" && call.op === "insert"),
    ).toBe(false);

    await vi.waitFor(() => expect(completeText).toHaveBeenCalled());
    answer(compiled("Standards"));
    await done;

    const finished = calls
      .filter((call) => call.table === "playbook_imports" && call.op === "update")
      .map((call) => call.values as Record<string, unknown>)
      .find((values) => values.status === "completed");
    expect(finished?.playbook_id).toEqual(expect.any(String));
  });

  it("refuses an unusable request itself rather than in the background", async () => {
    const { db } = fakeDb(null);
    const completeText = vi.fn();

    await expect(
      startPlaybookImport({
        userId: "u1",
        filename: "Standards.txt",
        buffer: await sourceDocx(),
        model: MODEL,
        db,
        dependencies: { completeText },
      }),
    ).rejects.toThrow(/\.docx or \.pdf/);
    expect(completeText).not.toHaveBeenCalled();
  });
});
