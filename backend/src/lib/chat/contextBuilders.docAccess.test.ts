import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// buildDocContext — which attached documents the model may actually read.
//
// The builder used to filter with `.eq("user_id", userId)`: "I uploaded it"
// stood in for "I may read it". So a colleague's document in a shared
// organization matter, and any document whose uploader's account had been
// deleted (documents.user_id → NULL), were dropped from the context — the
// assistant claimed it could not see a file the caller has full access to.
//
// The verdict is now per document (ensureDocAccess), which must cut BOTH
// ways: being mentioned in a chat the caller can read is not itself access.
// ---------------------------------------------------------------------------

vi.mock("../supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../storage", () => ({ downloadFile: vi.fn() }));

const ensureDocAccess = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("../access", () => ({
  ensureDocAccess: (...args: unknown[]) => ensureDocAccess(...args),
}));

// Version enrichment is a separate concern; give every surviving doc a path
// so the builder's "no bytes yet" skip never masks an access result.
vi.mock("../documentVersions", () => ({
  attachActiveVersionPaths: vi.fn(
    async (_db: unknown, docs: Record<string, unknown>[]) => {
      for (const doc of docs) {
        doc.storage_path = `docs/${doc.id}.docx`;
        doc.filename = `${doc.id}.docx`;
        doc.file_type = "docx";
      }
      return docs;
    },
  ),
}));

import { buildDocContext } from "./contextBuilders";

type Doc = {
  id: string;
  user_id: string | null;
  project_id: string | null;
  org_id?: string | null;
  workflow_id?: string | null;
  status?: string;
};

/**
 * Honours the `.eq()` filters it is given, so a test fails if the builder
 * goes back to scoping documents by uploader in SQL.
 */
function makeDb(docs: Doc[]) {
  return {
    from: () => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        select: () => b,
        is: () => b,
        order: () => b,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return b;
        },
        in: (column: string, value: unknown) => {
          filters[`in:${column}`] = value;
          return b;
        },
        then: (resolve: (v: unknown) => unknown) => {
          const ids = (filters["in:id"] as string[] | undefined) ?? null;
          const data = docs.filter(
            (doc) =>
              (!ids || ids.includes(doc.id)) &&
              Object.entries(filters).every(
                ([column, value]) =>
                  column.startsWith("in:") ||
                  (doc as Record<string, unknown>)[column] === value,
              ),
          );
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return b;
    },
  } as never;
}

const message = (documentIds: string[]) => [
  {
    role: "user" as const,
    content: "look at these",
    files: documentIds.map((id) => ({ document_id: id })),
  },
] as never;

describe("buildDocContext access scoping", () => {
  beforeEach(() => {
    ensureDocAccess.mockReset().mockResolvedValue({ ok: true });
  });

  it("includes documents the caller did not upload but may read", async () => {
    const db = makeDb([
      { id: "d-colleague", user_id: "u2", project_id: "p1", status: "ready" },
      { id: "d-detached", user_id: null, project_id: "p1", status: "ready" },
    ]);

    const { docIndex } = await buildDocContext(
      message(["d-colleague", "d-detached"]),
      "u1",
      db,
      null,
      "chat_messages",
      "u1@test.local",
    );

    expect(
      Object.values(docIndex).map((entry) => entry.document_id).sort(),
    ).toEqual(["d-colleague", "d-detached"]);
  });

  it("drops a document the caller has no verdict for, however it was cited", async () => {
    ensureDocAccess.mockImplementation(async (doc: unknown) => ({
      ok: (doc as { id: string }).id === "d-mine",
    }));
    const db = makeDb([
      { id: "d-mine", user_id: "u1", project_id: null, status: "ready" },
      { id: "d-walled", user_id: "u2", project_id: "p-walled", status: "ready" },
    ]);

    const { docIndex, docStore } = await buildDocContext(
      message(["d-mine", "d-walled"]),
      "u1",
      db,
      null,
      "chat_messages",
      "u1@test.local",
    );

    expect(Object.values(docIndex).map((entry) => entry.document_id)).toEqual([
      "d-mine",
    ]);
    expect([...docStore.values()].map((entry) => entry.storage_path)).toEqual([
      "docs/d-mine.docx",
    ]);
  });

  it("passes the caller's email so a direct grant still resolves", async () => {
    const db = makeDb([
      { id: "d1", user_id: "u2", project_id: "p1", status: "ready" },
    ]);

    await buildDocContext(
      message(["d1"]),
      "u1",
      db,
      null,
      "chat_messages",
      "u1@test.local",
    );

    expect(ensureDocAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d1" }),
      "u1",
      "u1@test.local",
      db,
    );
  });
});
