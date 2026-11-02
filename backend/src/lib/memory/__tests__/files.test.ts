import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../appError";
import {
  ensureMemoryFile,
  MemoryConversationNotQuietError,
  MemoryDisabledError,
  MemoryEpochSupersededError,
  MemoryJobSupersededError,
  MemoryRevisionConflictError,
  MemoryValidationError,
  normalizeMemoryMarkdown,
  wipeMemoryFile,
  writeMemoryFile,
  type MemoryFileRow,
} from "../files";

const file: MemoryFileRow = {
  id: "file-1",
  scope: "user",
  user_id: "user-1",
  project_id: null,
  enabled: true,
  epoch: 9,
  revision: 3,
  content: "# Existing",
  content_sha256: createHash("sha256").update("# Existing", "utf8").digest("hex"),
  size_bytes: 10,
  last_source_job_id: null,
  status: "idle",
  last_error_code: null,
  learning_cutoff_at: "2026-09-05T00:00:00.000Z",
  last_source: "manual",
  updated_by: "user-1",
  created_at: "2026-09-05T00:00:00.000Z",
  updated_at: "2026-09-05T00:00:00.000Z",
};

/** A db whose reads always resolve to `row` and whose rpc is scripted. */
function dbFor(
  row: MemoryFileRow | null,
  rpc: (name: string, args: Record<string, unknown>) => unknown = () => ({
    data: [{ applied: true, new_revision: 4 }],
    error: null,
  }),
) {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "is", "order", "limit", "delete", "update", "in", "upsert"]) {
    builder[name] = () => builder;
  }
  builder.maybeSingle = async () => ({ data: row, error: null });
  builder.single = async () => ({ data: row, error: null });
  return {
    from: () => builder,
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) =>
      rpc(name, args),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("memory failure classes", () => {
  it.each([
    [MemoryValidationError, "memory.validation"],
    [MemoryRevisionConflictError, "memory.revision_conflict"],
    [MemoryDisabledError, "memory.disabled"],
    [MemoryJobSupersededError, "memory.job_superseded"],
    [MemoryEpochSupersededError, "memory.epoch_superseded"],
    [MemoryConversationNotQuietError, "memory.conversation_not_quiet"],
  ])("%o is an AppError whose kind names the failure", (Failure, kind) => {
    const cause = new Error("raw database internals");
    const error = new Failure("fixed text", { cause });
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Failure);
    expect(error.kind).toBe(kind);
    expect(error.name).toBe(Failure.name);
    expect(error.message).toBe("fixed text");
    expect(error.cause).toBe(cause);
    expect(new Failure("no cause").cause).toBeUndefined();
  });

  it("raises the row lock's conflict under its kind", async () => {
    const db = dbFor({ ...file, revision: 5 }, () => ({
      data: null,
      error: { message: "error: memory_revision_conflict" },
    }));
    const thrown = await writeMemoryFile({
      db: db as never,
      file,
      content: "# Next",
      expectedRevision: 3,
      source: "manual",
      updatedBy: "user-1",
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(MemoryRevisionConflictError);
    expect((thrown as AppError).kind).toBe("memory.revision_conflict");
  });
});

describe("direct memory file writes", () => {
  it("creates a missing project memory file enabled by default", async () => {
    const projectFile: MemoryFileRow = {
      ...file,
      id: "project-file-1",
      scope: "project",
      user_id: null,
      project_id: "project-1",
      content: "",
      content_sha256: null,
      size_bytes: 0,
      revision: 0,
    };
    const maybeSingle = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: projectFile, error: null });
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.upsert = vi.fn(() => builder);
    builder.maybeSingle = maybeSingle;
    const db = { from: vi.fn(() => builder) };

    await expect(
      ensureMemoryFile(db as never, "project", "project-1"),
    ).resolves.toEqual(projectFile);
    expect(builder.upsert).toHaveBeenCalledWith(
      {
        scope: "project",
        project_id: "project-1",
        enabled: true,
      },
      { onConflict: "project_id", ignoreDuplicates: true },
    );
  });

  // A person has one memory per workspace: Personal, and one for each team
  // organization they belong to.
  describe("a person's memory for one workspace", () => {
    /** Records each lookup's filters; answers them from `found` in turn. */
    function workspaceDb(
      found: Array<{ data: unknown; error: unknown }>,
      rpc: (name: string, args: Record<string, unknown>) => unknown = () => ({
        data: [],
        error: null,
      }),
    ) {
      const lookups: Array<[string, ...unknown[]][]> = [];
      const upserts: unknown[] = [];
      const db = {
        from: vi.fn(() => {
          const filters: [string, ...unknown[]][] = [];
          lookups.push(filters);
          const builder: Record<string, unknown> = {
            select: () => builder,
            eq: (...args: unknown[]) => (filters.push(["eq", ...args]), builder),
            is: (...args: unknown[]) => (filters.push(["is", ...args]), builder),
            upsert: (payload: unknown) => (upserts.push(payload), builder),
            maybeSingle: async () => found.shift() ?? { data: null, error: null },
            single: async () => found.shift() ?? { data: null, error: null },
          };
          return builder;
        }),
        rpc: vi.fn(async (name: string, args: Record<string, unknown>) =>
          rpc(name, args),
        ),
      };
      return { db, lookups, upserts };
    }
    const workspaceFile: MemoryFileRow = {
      ...file,
      id: "file-org",
      org_id: "org-1",
    };

    it("looks for the file of that person in that organization", async () => {
      const { db, lookups } = workspaceDb([{ data: workspaceFile, error: null }]);
      await expect(
        ensureMemoryFile(db as never, "user", "user-1", "org-1"),
      ).resolves.toEqual(workspaceFile);
      expect(lookups[0]).toEqual([
        ["eq", "scope", "user"],
        ["eq", "user_id", "user-1"],
        ["eq", "org_id", "org-1"],
      ]);
      expect(db.rpc).not.toHaveBeenCalled();
    });

    it("looks for Personal as the file with no organization, never 'any file of theirs'", async () => {
      const { db, lookups } = workspaceDb([{ data: file, error: null }]);
      await ensureMemoryFile(db as never, "user", "user-1");
      expect(lookups[0]).toEqual([
        ["eq", "scope", "user"],
        ["eq", "user_id", "user-1"],
        ["is", "org_id", null],
      ]);
    });

    it("has the database create a missing one, which knows who belongs where", async () => {
      const { db } = workspaceDb([{ data: null, error: null }], () => ({
        data: [workspaceFile],
        error: null,
      }));
      await expect(
        ensureMemoryFile(db as never, "user", "user-1", "org-1"),
      ).resolves.toEqual(workspaceFile);
      expect(db.rpc).toHaveBeenCalledWith("ensure_user_memory_file", {
        p_user_id: "user-1",
        p_org_id: "org-1",
      });
    });

    it("refuses a memory in an organization the person does not belong to", async () => {
      // The database returns no row for a non-member.
      const { db } = workspaceDb([{ data: null, error: null }]);
      await expect(
        ensureMemoryFile(db as never, "user", "user-1", "org-elsewhere"),
      ).rejects.toThrow("Failed to create memory settings");
    });

    it("re-reads the same workspace's file after a write, not the person's Personal one", async () => {
      const { db, lookups } = workspaceDb([{ data: workspaceFile, error: null }], () => ({
        data: [{ applied: true, new_revision: 4 }],
        error: null,
      }));
      await writeMemoryFile({
        db: db as never,
        file: workspaceFile,
        content: "# Learned at the firm",
        expectedRevision: 3,
        source: "manual",
        updatedBy: "user-1",
      });
      expect(lookups.at(-1)).toContainEqual(["eq", "org_id", "org-1"]);
    });

    it("still serves Personal from a database that has not been migrated yet", async () => {
      // No org_id column: the filter fails, and there is one file per person.
      const { db, lookups } = workspaceDb([
        { data: null, error: { code: "42703", message: "column does not exist" } },
        { data: file, error: null },
      ]);
      await expect(
        ensureMemoryFile(db as never, "user", "user-1"),
      ).resolves.toEqual(file);
      expect(lookups[1]).toEqual([
        ["eq", "scope", "user"],
        ["eq", "user_id", "user-1"],
      ]);
    });

    it("has no workspace memory to offer from such a database", async () => {
      const { db } = workspaceDb([
        { data: null, error: { code: "42703", message: "column does not exist" } },
      ]);
      await expect(
        ensureMemoryFile(db as never, "user", "user-1", "org-1"),
      ).rejects.toThrow("Failed to load memory settings");
    });
  });

  it("rejects executable HTML but preserves Markdown hard breaks", () => {
    expect(normalizeMemoryMarkdown("first  \r\nsecond   \n")).toBe(
      "first  \nsecond  \n",
    );
    expect(() => normalizeMemoryMarkdown('<img src="x" onerror="run()">'))
      .toThrow("content contains executable HTML");
    expect(() => normalizeMemoryMarkdown("<script>alert(1)</script>"))
      .toThrow("content contains executable HTML");
    expect(() => normalizeMemoryMarkdown('<a href="javascript:run()">x</a>'))
      .toThrow("content contains executable HTML");
  });

  it("sends the normalized body, its digest and size under the loaded CAS token", async () => {
    const db = dbFor(file);

    const result = await writeMemoryFile({
      db: db as never,
      file,
      content: "# Next  \r\n",
      expectedRevision: 3,
      source: "manual",
      updatedBy: "user-1",
    });

    expect(db.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = db.rpc.mock.calls[0]!;
    expect(name).toBe("write_memory_file");
    expect(args).toMatchObject({
      p_memory_file_id: "file-1",
      p_expected_revision: 3,
      p_expected_epoch: 9,
      p_content: "# Next  \n",
      p_content_sha256: createHash("sha256")
        .update("# Next  \n", "utf8")
        .digest("hex"),
      p_size_bytes: Buffer.byteLength("# Next  \n", "utf8"),
      p_source: "manual",
      p_source_job_id: null,
    });
    expect(result.applied).toBe(true);
  });

  it("lets the row lock decide that an unchanged body is not a write", async () => {
    // The RPC answers applied=false for a body whose digest matches, while
    // still stamping the curator's job receipt. A client-side short-circuit
    // would skip that receipt and make a retried job re-run the model.
    const db = dbFor(file, () => ({
      data: [{ applied: false, new_revision: 3 }],
      error: null,
    }));

    const result = await writeMemoryFile({
      db: db as never,
      file,
      content: "# Existing",
      expectedRevision: 3,
      source: "curator",
      updatedBy: "user-1",
      sourceJobId: "job-1",
    });

    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(false);
    expect(result.current.content).toBe("# Existing");
    expect(result.current.revision).toBe(3);
  });

  it("maps a stale draft to a revision conflict raised under the row lock", async () => {
    const db = dbFor({ ...file, revision: 5 }, () => ({
      data: null,
      error: { message: "error: memory_revision_conflict" },
    }));

    await expect(
      writeMemoryFile({
        db: db as never,
        file,
        content: "# Next",
        expectedRevision: 3,
        source: "manual",
        updatedBy: "user-1",
      }),
    ).rejects.toThrow("Memory revision changed");
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["memory_revision_conflict", "Memory revision changed"],
    ["memory_disabled", "Memory is disabled"],
    ["memory_conversation_not_quiet", "Memory conversation is not quiet"],
    ["memory_job_superseded", "Memory curator job was superseded"],
  ])("surfaces %s as its own failure", async (code, message) => {
    const db = dbFor(file, () => ({
      data: null,
      error: { message: `error: ${code}` },
    }));

    await expect(
      writeMemoryFile({
        db: db as never,
        file,
        content: "# Next",
        expectedRevision: 3,
        source: "manual",
        updatedBy: "user-1",
      }),
    ).rejects.toThrow(message);
  });

  it("reports a superseded scope when a fenced curator write loses its epoch", async () => {
    const db = dbFor(file, () => ({
      data: null,
      error: { message: "error: memory_epoch_conflict" },
    }));

    await expect(
      writeMemoryFile({
        db: db as never,
        file,
        content: "# Next",
        expectedRevision: 3,
        expectedEpoch: 9,
        source: "curator",
        updatedBy: "user-1",
      }),
    ).rejects.toThrow("Memory scope was reset");
  });

  it("uses the lock-resolved enable state and monotonic CAS token after wipe", async () => {
    const db = dbFor(file, () => ({
      data: [
        {
          new_epoch: 10,
          new_revision: 4,
          effective_enabled: false,
          mutation_at: "2026-09-07T00:00:00.000Z",
          mutation_by: "user-1",
        },
      ],
      error: null,
    }));

    const current = await wipeMemoryFile({
      db: db as never,
      file,
      enabled: null,
      updatedBy: "user-1",
      source: "settings",
    });

    expect(db.rpc).toHaveBeenCalledWith("wipe_memory_file", {
      p_memory_file_id: "file-1",
      p_enabled: null,
      p_updated_by: "user-1",
      p_source: "settings",
    });
    expect(current).toMatchObject({
      enabled: false,
      content: "",
      revision: 4,
      hash: null,
      updated_at: null,
      updated_by: null,
      source: "settings",
      status: "idle",
    });
  });
});
