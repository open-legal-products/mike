import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
const access = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/access", async (original) => ({
  ...(await original<typeof import("../../../lib/access")>()),
  checkProjectAccess: access,
}));
import { renameDocument } from "../documents.service";
import { renameProjectDocument } from "../../projects/projects.service";
import { renameLibraryDocument } from "../../library/library.service";

beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ ok: true, projectRole: "editor" });
});
const args = {
  userId: "actor",
  documentId: "doc",
  filename: "Renamed",
  scope: { kind: "project" as const, projectId: "project" },
};
const doc = { id: "doc", current_version_id: "v2" };
function happyDb(
  storedFilename = "Renamed.pdf",
  currentFilename = "Original.pdf",
) {
  return scriptedDb([
    { table: "documents", data: doc },
    { table: "document_versions", data: { filename: currentFilename } },
    {
      table: "documents",
      op: "update",
      data: { ...doc, library_folder_id: "folder" },
    },
    {
      table: "document_versions",
      op: "update",
      data: { filename: storedFilename },
    },
  ]);
}

describe("shared document rename", () => {
  it.each([
    { kind: "project" as const, projectId: "project" },
    { kind: "library" as const, libraryKind: "file" as const },
    { kind: "library" as const, libraryKind: "template" as const },
  ])("scopes both reads and writes for $kind $libraryKind", async (scope) => {
    const fake = happyDb();
    const result = await renameDocument(fake.db, { ...args, scope });
    expect(result).toMatchObject({
      ok: true,
      data: { filename: "Renamed.pdf" },
    });
    const filters =
      scope.kind === "project"
        ? [["eq", "project_id", "project"]]
        : [
            ["eq", "user_id", "actor"],
            ["is", "project_id", null],
            scope.libraryKind === "file"
              ? ["or", "library_kind.eq.file,library_kind.is.null"]
              : ["eq", "library_kind", "template"],
          ];
    for (const call of fake.calls.filter(
      (call) => call.table === "documents",
    )) {
      expect(call.filters).toEqual(
        expect.arrayContaining([["eq", "id", "doc"], ...filters]),
      );
    }
    for (const call of fake.calls.filter(
      (call) => call.table === "document_versions",
    )) {
      expect(call.filters).toEqual([
        ["eq", "id", "v2"],
        ["eq", "document_id", "doc"],
      ]);
    }
    if (scope.kind === "library") expect(access).not.toHaveBeenCalled();
    fake.done();
  });

  it.each([
    ["  Renamed  ", "Original.PDF", "Renamed.PDF"],
    ["Renamed.docx", "Original.pdf", "Renamed.docx"],
    ["Renamed", "No extension", "Renamed"],
    ["x".repeat(210), "Original.pdf", "x".repeat(200) + ".pdf"],
  ])(
    "preserves existing filename policy for %s",
    async (filename, current, expected) => {
      const fake = happyDb(expected, current);
      await renameDocument(fake.db, { ...args, filename });
      expect(fake.calls[3].payload).toEqual({ filename: expected });
      fake.done();
    },
  );

  it.each(["viewer", null])(
    "refuses insufficient project access (%s) before touching documents",
    async (role) => {
      access.mockResolvedValue(
        role ? { ok: true, projectRole: role } : { ok: false },
      );
      const fake = scriptedDb([]);
      expect(await renameDocument(fake.db, args)).toMatchObject({
        ok: false,
        kind: "forbidden",
      });
      expect(access).toHaveBeenCalledWith(
        "project",
        "actor",
        undefined,
        fake.db,
      );
      fake.done();
    },
  );

  it.each([null, { id: "doc", current_version_id: null }])(
    "does not touch versions when the scoped document or its active version is missing",
    async (data) => {
      const fake = scriptedDb([{ table: "documents", data }]);
      expect(await renameDocument(fake.db, args)).toMatchObject({
        ok: false,
        kind: "not_found",
      });
      fake.done();
    },
  );

  it.each([null, 12, "   "])(
    "refuses invalid filenames without a write",
    async (filename) => {
      const fake = scriptedDb([
        { table: "documents", data: doc },
        { table: "document_versions", data: { filename: "old.pdf" } },
      ]);
      expect(
        await renameDocument(fake.db, { ...args, filename }),
      ).toMatchObject({ ok: false, kind: "validation" });
      fake.done();
    },
  );

  it("stops if the scoped document update fails", async () => {
    const fake = scriptedDb([
      { table: "documents", data: doc },
      { table: "document_versions", data: { filename: "old.pdf" } },
      {
        table: "documents",
        op: "update",
        error: { message: "no longer accessible" },
      },
    ]);
    expect(await renameDocument(fake.db, args)).toMatchObject({
      ok: false,
      kind: "not_found",
    });
    fake.done();
  });

  it.each([null, { message: "database failure" }])(
    "reports a missing or failed version update instead of echoing success",
    async (error) => {
      const fake = scriptedDb([
        { table: "documents", data: doc },
        { table: "document_versions", data: { filename: "old.pdf" } },
        { table: "documents", op: "update", data: doc },
        { table: "document_versions", op: "update", error },
      ]);
      expect(await renameDocument(fake.db, args)).toMatchObject({
        ok: false,
        kind: error ? "error" : "not_found",
      });
      fake.done();
    },
  );

  it("returns the stored filename and preserves the different caller response shapes", async () => {
    const project = happyDb("Stored.pdf");
    const library = happyDb("Stored.pdf");
    expect(
      await renameProjectDocument(project.db, {
        ...args,
        projectId: "project",
      }),
    ).toMatchObject({ ok: true, doc: { filename: "Stored.pdf" } });
    expect(
      await renameLibraryDocument(
        library.db,
        "actor",
        "file",
        "doc",
        "Renamed",
      ),
    ).toMatchObject({
      ok: true,
      data: { filename: "Stored.pdf", folder_id: "folder" },
    });
    project.done();
    library.done();
  });
});
