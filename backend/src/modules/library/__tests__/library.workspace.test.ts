import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/documentVersions", () => ({
  attachActiveVersionPaths: vi.fn(async () => undefined),
  attachLatestVersionNumbers: vi.fn(async () => undefined),
}));
vi.mock("../../documents/documents.service", () => ({
  renameDocument: vi.fn(),
  deleteCollectionDocuments: vi.fn(async () => ({
    ok: true,
    data: { deletedIds: [] },
  })),
}));

import {
  createLibraryFolder,
  getLibrary,
  getLibraryDocumentIds,
  getLibraryFilterOptions,
  moveLibraryDocument,
  resolveLibraryFolderPath,
  searchLibraryDocuments,
  updateLibraryFolder,
} from "../library.service";

// The library is per workspace: a person's own documents and folders in
// Personal, and their own in each organization they belong to. A folder and
// what is in it are always in the same workspace.

type Row = Record<string, unknown>;
const ORG = "7b1d9d0e-3c5a-4f6e-9a51-0c2f7d3e8a11";
const PAGE = { limit: 50, offset: 0 };

/** A table-backed stand-in that applies the filters the service sends. */
function makeDb(tables: Record<string, Row[]>) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let write: { op: "insert" | "update"; payload: Row } | null = null;
    const rows = () => (tables[table] ??= []);
    const run = () => {
      if (write?.op === "insert") {
        const created = { id: `new-${rows().length + 1}`, ...write.payload };
        rows().push(created);
        return [created];
      }
      const matched = rows().filter((row) => filters.every((test) => test(row)));
      if (write?.op === "update")
        for (const row of matched) Object.assign(row, write.payload);
      return matched;
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      range: () => builder,
      // The file/template split is not what these tests are about.
      or: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      insert: (payload: Row) => {
        write = { op: "insert", payload };
        return builder;
      },
      update: (payload: Row) => {
        write = { op: "update", payload };
        return builder;
      },
      single: async () => {
        const [row] = run();
        return row
          ? { data: row, error: null }
          : { data: null, error: { message: "no rows" } };
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: run(), error: null }),
    };
    return builder;
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return { data: [], error: null };
  });
  return { db: { from, rpc } as never, tables, rpcCalls };
}

const seed = () =>
  makeDb({
    documents: [
      { id: "d-personal", user_id: "u1", project_id: null, org_id: null, library_folder_id: null },
      { id: "d-firm", user_id: "u1", project_id: null, org_id: ORG, library_folder_id: null },
      { id: "d-colleague", user_id: "u2", project_id: null, org_id: ORG, library_folder_id: null },
    ],
    library_folders: [
      { id: "f-personal", user_id: "u1", library_kind: "file", org_id: null, parent_folder_id: null },
      { id: "f-firm", user_id: "u1", library_kind: "file", org_id: ORG, parent_folder_id: null },
    ],
  });
const ids = (rows: unknown[]) => (rows as Row[]).map((row) => row.id);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listing the library", () => {
  it("shows an organization's workspace only what the caller filed there", async () => {
    const { db } = seed();
    const result = await getLibrary(db, "u1", "file", null, PAGE, ORG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ids(result.data.documents)).toEqual(["d-firm"]);
    expect(ids(result.data.folders)).toEqual(["f-firm"]);
  });

  it("shows Personal only what has no organization", async () => {
    const { db } = seed();
    const result = await getLibrary(db, "u1", "file", null, PAGE, "personal");
    if (!result.ok) throw new Error("expected the library to load");
    expect(ids(result.data.documents)).toEqual(["d-personal"]);
    expect(ids(result.data.folders)).toEqual(["f-personal"]);
  });

  it("does not narrow for a caller that names no workspace", async () => {
    const { db } = seed();
    const result = await getLibrary(db, "u1", "file", null, PAGE);
    if (!result.ok) throw new Error("expected the library to load");
    expect(ids(result.data.documents)).toEqual(["d-personal", "d-firm"]);
  });

  it("does not open another workspace's folder", async () => {
    const { db } = seed();
    await expect(
      getLibrary(db, "u1", "file", "f-personal", PAGE, ORG),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it("narrows the search, the facets and the id list in the database", async () => {
    const { db, rpcCalls } = seed();
    const sort = { key: "updated", direction: "desc" as const };
    await searchLibraryDocuments(db, "u1", "file", null, null, sort, PAGE, ORG);
    await getLibraryFilterOptions(db, "u1", "file", ORG);
    await getLibraryDocumentIds(db, "u1", "file", null, null, ORG);
    expect(rpcCalls.map(({ name, args }) => [name, args.p_workspace])).toEqual([
      ["search_library_documents", ORG],
      ["get_library_filter_options", ORG],
      ["get_library_document_ids", ORG],
    ]);

    // With no workspace named the argument is left out altogether, so the
    // call is the one made before the library had workspaces.
    rpcCalls.length = 0;
    await searchLibraryDocuments(db, "u1", "file", null, null, sort, PAGE);
    expect(rpcCalls[0].args).not.toHaveProperty("p_workspace");
  });
});

describe("folders", () => {
  it("makes a top-level folder in the workspace the caller is working in", async () => {
    const { db, tables } = seed();
    await createLibraryFolder(db, "u1", "file", { name: "Precedents" }, ORG);
    await createLibraryFolder(db, "u1", "file", { name: "Precedents" }, "personal");
    const made = tables.library_folders.filter((f) => f.name === "Precedents");
    expect(made.map((folder) => folder.org_id ?? null)).toEqual([ORG, null]);
  });

  it("puts a subfolder in its parent's workspace", async () => {
    const { db, tables } = seed();
    // Asked for without naming a workspace: the parent still decides.
    await createLibraryFolder(db, "u1", "file", {
      name: "Sub",
      parent_folder_id: "f-firm",
    });
    expect(tables.library_folders.find((f) => f.name === "Sub")).toMatchObject({
      org_id: ORG,
      parent_folder_id: "f-firm",
    });
  });

  it("does not make a folder under another workspace's parent", async () => {
    const { db, tables } = seed();
    await expect(
      createLibraryFolder(
        db,
        "u1",
        "file",
        { name: "Sub", parent_folder_id: "f-personal" },
        ORG,
      ),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    expect(tables.library_folders).toHaveLength(2);
  });

  it("does not move a folder under a parent in another workspace", async () => {
    const { db, tables } = seed();
    await expect(
      updateLibraryFolder(db, "u1", "file", "f-firm", {
        parent_folder_id: "f-personal",
      }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    expect(
      tables.library_folders.find((f) => f.id === "f-firm")?.parent_folder_id,
    ).toBeNull();
  });

  it("walks an uploaded folder path in one workspace", async () => {
    const { db, rpcCalls } = seed();
    await resolveLibraryFolderPath(
      db,
      "u1",
      "file",
      { segments: ["Deal", "Disclosure"], conflict_resolution: "reuse" },
      ORG,
    );
    expect(rpcCalls[0]).toMatchObject({
      name: "resolve_library_folder_path",
      args: { target_org_id: ORG },
    });

    // From a base folder, the folder's own workspace, whatever was asked.
    rpcCalls.length = 0;
    await resolveLibraryFolderPath(db, "u1", "file", {
      base_folder_id: "f-firm",
      segments: ["Disclosure"],
      conflict_resolution: "reuse",
    });
    expect(rpcCalls[0].args).toMatchObject({ target_org_id: ORG });

    // In Personal the argument is left out.
    rpcCalls.length = 0;
    await resolveLibraryFolderPath(
      db,
      "u1",
      "file",
      { segments: ["Deal"], conflict_resolution: "reuse" },
      "personal",
    );
    expect(rpcCalls[0].args).not.toHaveProperty("target_org_id");
  });
});

describe("moving a document into a folder", () => {
  it("moves it within its own workspace", async () => {
    const { db, tables } = seed();
    await expect(
      moveLibraryDocument(db, "u1", "file", "d-firm", "f-firm", ORG),
    ).resolves.toMatchObject({ ok: true });
    expect(
      tables.documents.find((d) => d.id === "d-firm")?.library_folder_id,
    ).toBe("f-firm");
  });

  it.each([
    ["an organization's document into a Personal folder", "d-firm", "f-personal"],
    ["a Personal document into an organization's folder", "d-personal", "f-firm"],
  ])("does not move %s", async (_label, documentId, folderId) => {
    const { db, tables } = seed();
    // Even for a caller that names no workspace at all.
    await expect(
      moveLibraryDocument(db, "u1", "file", documentId, folderId),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    expect(
      tables.documents.find((d) => d.id === documentId)?.library_folder_id,
    ).toBeNull();
  });
});

describe("the library routes", () => {
  it("resolve the workspace on every route, including ones added later", () => {
    // Each route must go through requireLibraryAuth, which checks that the
    // caller belongs to the workspace named before anything is listed or
    // filed there; requireAuth alone would skip that.
    const source = readFileSync(
      resolve(__dirname, "../library.routes.ts"),
      "utf8",
    );
    const guards = [
      ...source.matchAll(
        /libraryRouter\.(?:get|post|put|patch|delete)\(\s*"[^"]*",\s*(\w+),/g,
      ),
    ].map(([, guard]) => guard);
    expect(guards.length).toBeGreaterThanOrEqual(12);
    expect(guards.filter((guard) => guard !== "requireLibraryAuth")).toEqual([]);
  });
});
