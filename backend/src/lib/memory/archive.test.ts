import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMemoryCurrent, listAccessibleProjectIds } =
  vi.hoisted(() => ({
    getMemoryCurrent: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
  }));

vi.mock("../access", () => ({
  listAccessibleProjectIds,
  // Not consulted any more: the run's listing is the verdict.
  checkProjectAccess: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./files", () => ({ getMemoryCurrent }));

import JSZip from "jszip";
import { buildMemoryArchive } from "./archive";

function fakeDb(rows: Record<string, Record<string, unknown>[]>) {
  return {
    from: vi.fn((table: string) => {
      const result = { data: [...(rows[table] ?? [])], error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (value: typeof result) => unknown) => resolve(result),
        maybeSingle: async () => ({ data: result.data[0] ?? null, error: null }),
      };
      for (const name of ["select", "eq", "not"])
        builder[name] = () => builder;
      builder.in = (column: string, values: unknown[]) => {
        result.data = result.data.filter((row) => values.includes(row[column]));
        return builder;
      };
      builder.is = (column: string) => {
        // Unlike organizations, projects have no deleted_at column.
        if (table === "projects" && column === "deleted_at")
          throw new Error("column projects.deleted_at does not exist");
        return builder;
      };
      return builder;
    }),
  };
}

async function files(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  return { zip, names };
}

describe("buildMemoryArchive", () => {
  const rows = {
    projects: [
      { id: "p2", name: "Revoked", org_id: null },
      { id: "p1", name: "../Matter/Alpha", org_id: null },
      { id: "p3", name: "Firm matter", org_id: "org-1" },
    ],
    organizations: [{ id: "org-1", name: "Acme/../LLP" }],
    memory_files: ["p1", "p2", "p3"].map((id) => ({ project_id: id, content: `# Project ${id}` })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // p2 was revoked before the queued export ran: this run's verdict omits it.
    listAccessibleProjectIds.mockResolvedValue(["p1", "p3"]);
    getMemoryCurrent.mockImplementation(
      async (_db: unknown, scope: string, ownerId: string, orgId?: string | null) => ({
        current: {
          content:
            scope === "user"
              ? orgId
                ? `# Learned at ${orgId}`
                : "# App memory"
              : `# Project ${ownerId}`,
        },
      }),
    );
  });

  it("holds Personal's memory and its currently accessible project Markdown, without unsafe paths", async () => {
    const db = fakeDb(rows);
    const { zip, names } = await files(
      await buildMemoryArchive(db as never, "u1", "u1@example.test"),
    );
    const projectFile = names.find((name) => name.includes("--p1/"));

    expect(await zip.file("app/memory.md")?.async("string")).toBe("# App memory");
    expect(getMemoryCurrent).toHaveBeenCalledWith(db, "user", "u1", null);
    expect(projectFile).toBeTruthy();
    expect(projectFile).not.toContain("..");
    expect(projectFile).not.toContain("\\");
    expect(await zip.file(projectFile!)?.async("string")).toBe("# Project p1");
    // Revoked since, and another workspace's.
    expect(names.some((name) => name.includes("--p2/"))).toBe(false);
    expect(names.some((name) => name.includes("--p3/"))).toBe(false);
    expect(names.some((name) => name.startsWith("organizations/"))).toBe(false);
    expect(getMemoryCurrent).not.toHaveBeenCalledWith(db, "project", "p2");
  });

  it("reads project memories in batches instead of once per project", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `q${i}`);
    listAccessibleProjectIds.mockResolvedValue(ids);
    const db = fakeDb({
      projects: ids.map((id) => ({ id, name: id, org_id: null })),
      memory_files: ids.map((id) => ({ project_id: id, content: `# ${id}` })),
    });
    const { zip, names } = await files(await buildMemoryArchive(db as never, "u1", "u1@example.test"));
    expect(names.filter((name) => name.startsWith("projects/"))).toHaveLength(60);
    // Only the caller's own memory goes through the per-file loader.
    expect(getMemoryCurrent).toHaveBeenCalledTimes(1);
    expect(await zip.file("projects/q7--q7/memory.md")?.async("string")).toBe("# q7");
    expect(db.from.mock.calls.filter(([table]) => table === "memory_files")).toHaveLength(2);
  });

  it("holds only an organization's memory and projects when it names one", async () => {
    const db = fakeDb(rows);
    const { zip, names } = await files(
      await buildMemoryArchive(db as never, "u1", "u1@example.test", "org-1"),
    );

    const workspaceFile = names.find((name) => name.startsWith("organizations/"));
    expect(workspaceFile).toMatch(/^organizations\/[^/]+--org-1\/memory\.md$/);
    expect(workspaceFile).not.toContain("..");
    expect(await zip.file(workspaceFile!)?.async("string")).toBe(
      "# Learned at org-1",
    );
    expect(names.some((name) => name.includes("--p3/"))).toBe(true);
    expect(names).not.toContain("app/memory.md");
    expect(names.some((name) => name.includes("--p1/"))).toBe(false);
  });
});
