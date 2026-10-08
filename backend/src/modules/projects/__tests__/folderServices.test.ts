import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
const mocks = vi.hoisted(() => ({ access: vi.fn(), cleanup: vi.fn() }));
vi.mock("../../../lib/access", async (original) => ({
  ...(await original<typeof import("../../../lib/access")>()),
  checkProjectAccess: mocks.access,
}));
vi.mock("../../../lib/dbq/enqueue", () => ({
  enqueueStorageCleanup: mocks.cleanup,
}));
import { updateProjectFolder, deleteProjectFolder } from "../projects.service";
import {
  updateLibraryFolder,
  deleteLibraryFolder,
} from "../../library/library.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ ok: true, projectRole: "editor" });
  mocks.cleanup.mockResolvedValue(undefined);
});
const actor = { userId: "actor", projectId: "p", folderId: "root" };

describe("folder callers retain their scope and failure policies", () => {
  // The gate still runs first; what changed is the ANSWER. A Viewer can see
  // the project, so they are refused by name (403) instead of being told the
  // matter is missing; `forbidden` (404) is now reserved for a caller
  // checkProjectAccess itself refuses.
  it("keeps project permissions ahead of all folder operations", async () => {
    mocks.access.mockResolvedValue({ ok: true, projectRole: "viewer" });
    const fake = scriptedDb([]);
    const refusal = {
      ok: false,
      kind: "role_forbidden",
      detail: "You do not have permission to organize documents in this project.",
    };
    expect(
      await updateProjectFolder(fake.db, {
        ...actor,
        body: { parent_folder_id: "parent" },
      }),
    ).toEqual(refusal);
    expect(await deleteProjectFolder(fake.db, actor)).toEqual(refusal);
    fake.done();
  });

  it("hides the project entirely from a caller with no access", async () => {
    mocks.access.mockResolvedValue({ ok: false });
    const fake = scriptedDb([]);
    expect(await deleteProjectFolder(fake.db, actor)).toEqual({
      ok: false,
      kind: "forbidden",
    });
    fake.done();
  });
  it("never walks a parent outside the project", async () => {
    const fake = scriptedDb([{ table: "project_subfolders", data: null }]);
    expect(
      await updateProjectFolder(fake.db, {
        ...actor,
        body: { parent_folder_id: "foreign" },
      }),
    ).toEqual({ ok: false, kind: "parent_not_found" });
    expect(fake.calls[0].filters).toEqual([
      ["eq", "id", "foreign"],
      ["eq", "project_id", "p"],
    ]);
    fake.done();
  });
  it("keeps a library parent walk restricted to actor and collection", async () => {
    const fake = scriptedDb([
      {
        table: "library_folders",
        data: { id: "root", parent_folder_id: null },
      },
      { table: "library_folders", data: null },
    ]);
    expect(
      await updateLibraryFolder(fake.db, "actor", "template", "root", {
        parent_folder_id: "foreign",
      }),
    ).toMatchObject({ ok: false, status: 404 });
    for (const call of fake.calls)
      expect(call.filters).toEqual(
        expect.arrayContaining([
          ["eq", "user_id", "actor"],
          ["eq", "library_kind", "template"],
        ]),
      );
    fake.done();
  });
  it("preserves the library cycle error", async () => {
    const fake = scriptedDb([
      {
        table: "library_folders",
        data: { id: "root", parent_folder_id: null },
      },
    ]);
    expect(
      await updateLibraryFolder(fake.db, "actor", "file", "root", {
        parent_folder_id: "root",
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      detail: "Cannot move a folder into itself or a descendant",
    });
    fake.done();
  });
  it("preserves the project's parent-existence check before rejecting a self move", async () => {
    const fake = scriptedDb([
      {
        table: "project_subfolders",
        data: { id: "root", parent_folder_id: null },
      },
    ]);
    expect(
      await updateProjectFolder(fake.db, {
        ...actor,
        body: { parent_folder_id: "root" },
      }),
    ).toEqual({ ok: false, kind: "cycle" });
    fake.done();
  });
  it.each(["project", "library"])(
    "does not delete the %s folder when document cleanup fails",
    async (kind) => {
      const library = kind === "library";
      const table = library ? "library_folders" : "project_subfolders";
      const fake = scriptedDb([
        {
          table,
          data: [
            { id: "root", parent_folder_id: null },
            { id: "child", parent_folder_id: "root" },
            { id: "other", parent_folder_id: null },
          ],
        },
        { table: "documents", data: [{ id: "doc", user_id: "actor" }] },
        ...(library ? [{ table: "documents", data: [{ id: "doc" }] }] : []),
        {
          table: "documents",
          op: "delete",
          error: { message: "version lookup failed" },
        },
      ]);
      const result = library
        ? await deleteLibraryFolder(fake.db, "actor", "file", "root")
        : await deleteProjectFolder(fake.db, actor);
      expect(result.ok).toBe(false);
      expect(fake.calls[1].filters).toContainEqual([
        "in",
        library ? "library_folder_id" : "folder_id",
        ["root", "child"],
      ]);
      expect(mocks.cleanup).not.toHaveBeenCalled();
      fake.done();
    },
  );

  // Deleting a single document is creator-scoped, so cascading a folder must
  // not let an Editor delete colleagues' documents wholesale.
  const subtree = {
    table: "project_subfolders",
    data: [
      { id: "root", parent_folder_id: null },
      { id: "child", parent_folder_id: "root" },
    ],
  };
  it.each([
    ["a colleague's document", "colleague"],
    ["a document whose creator is gone", null],
  ])("refuses an Editor when the subtree holds %s", async (_label, creator) => {
    const fake = scriptedDb([
      subtree,
      {
        table: "documents",
        data: [
          { id: "mine", user_id: "actor" },
          { id: "theirs", user_id: creator },
        ],
      },
    ]);
    expect(await deleteProjectFolder(fake.db, actor)).toEqual({
      ok: false,
      kind: "role_forbidden",
      detail:
        "This folder contains documents added by other people. Only the project owner can delete it.",
    });
    expect(fake.calls.some((call) => call.op === "delete")).toBe(false);
    fake.done();
  });

  it("lets an Owner clear a subtree holding colleagues' documents", async () => {
    mocks.access.mockResolvedValue({ ok: true, projectRole: "owner" });
    const fake = scriptedDb([
      subtree,
      { table: "documents", data: [{ id: "theirs", user_id: "colleague" }] },
      {
        table: "documents",
        op: "delete",
        error: { message: "stop after the gate" },
      },
    ]);
    expect(await deleteProjectFolder(fake.db, actor)).toMatchObject({
      ok: false,
      kind: "db_error",
    });
    fake.done();
  });
});
