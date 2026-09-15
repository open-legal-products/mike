import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
const cleanup = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/dbq/enqueue", () => ({ enqueueStorageCleanup: cleanup }));
import { deleteCollectionDocuments } from "../documents.service";

beforeEach(() => {
  vi.clearAllMocks();
  cleanup.mockResolvedValue(undefined);
});
const scope = { kind: "project" as const, projectId: "p" };

describe("collection document cleanup", () => {
  it("deletes within project scope; the database owns atomic file cleanup", async () => {
    const fake = scriptedDb([
      { table: "documents", op: "delete" },
    ]);
    expect(await deleteCollectionDocuments(fake.db, scope, ["doc"])).toEqual({
      ok: true,
      data: { deletedIds: ["doc"] },
    });
    expect(fake.calls[0].filters).toEqual([
      ["eq", "project_id", "p"],
      ["in", "id", ["doc"]],
    ]);
    expect(cleanup).not.toHaveBeenCalled();
    fake.done();
  });

  it.each(["file", "template"] as const)(
    "restricts library %s cleanup to eligible actor-owned standalone documents",
    async (libraryKind) => {
      const fake = scriptedDb([
        { table: "documents", data: [{ id: "owned" }] },
          { table: "documents", op: "delete" },
      ]);
      expect(
        await deleteCollectionDocuments(
          fake.db,
          { kind: "library", userId: "actor", libraryKind },
          ["owned", "foreign"],
        ),
      ).toMatchObject({ ok: true, data: { deletedIds: ["owned"] } });
      const filters = [
        ["eq", "user_id", "actor"],
        ["is", "project_id", null],
        libraryKind === "file"
          ? ["or", "library_kind.eq.file,library_kind.is.null"]
          : ["eq", "library_kind", "template"],
      ];
      expect(fake.calls[0].filters).toEqual([
        ...filters,
        ["in", "id", ["owned", "foreign"]],
      ]);
      expect(fake.calls[1].filters).toEqual([
        ...filters,
        ["in", "id", ["owned"]],
      ]);
      fake.done();
    },
  );

  it("does nothing for an empty collection", async () => {
    const fake = scriptedDb([]);
    expect(await deleteCollectionDocuments(fake.db, scope, [])).toEqual({
      ok: true,
      data: { deletedIds: [] },
    });
    expect(cleanup).not.toHaveBeenCalled();
    fake.done();
  });

  it.each([null, { message: "eligibility failed" }])(
    "does not read version paths when library eligibility is empty or fails",
    async (error) => {
      const fake = scriptedDb([{ table: "documents", data: [], error }]);
      const result = await deleteCollectionDocuments(
        fake.db,
        { kind: "library", userId: "actor", libraryKind: "file" },
        ["foreign"],
      );
      expect(result.ok).toBe(!error);
      expect(cleanup).not.toHaveBeenCalled();
      fake.done();
    },
  );

  it("does not queue cleanup when the row deletion fails", async () => {
    const error = { message: "delete failed" };
    const fake = scriptedDb([
      { table: "documents", op: "delete", error },
    ]);
    expect(await deleteCollectionDocuments(fake.db, scope, ["doc"])).toEqual({
      ok: false,
      kind: "error",
      error,
    });
    expect(cleanup).not.toHaveBeenCalled();
    fake.done();
  });

});
