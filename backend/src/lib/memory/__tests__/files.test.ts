import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureMemoryFile,
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
  for (const name of ["select", "eq", "order", "limit", "delete", "update", "in", "upsert"]) {
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
