import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkProjectAccess, getMemoryCurrent, listAccessibleProjectIds } =
  vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    getMemoryCurrent: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
  }));

vi.mock("../access", () => ({
  checkProjectAccess,
  listAccessibleProjectIds,
}));

vi.mock("./files", () => ({ getMemoryCurrent }));

import JSZip from "jszip";
import { buildMemoryArchive } from "./archive";

function fakeDb(rows: Record<string, Record<string, unknown>[]>) {
  return {
    from: vi.fn((table: string) => {
      const result = { data: rows[table] ?? [], error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (value: typeof result) => unknown) => resolve(result),
        maybeSingle: async () => ({ data: result.data[0] ?? null, error: null }),
      };
      for (const name of ["select", "eq", "not", "in"])
        builder[name] = () => builder;
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listAccessibleProjectIds.mockResolvedValue(["p1", "p2", "p3"]);
    checkProjectAccess.mockImplementation(async (projectId: string) => ({
      ok: projectId !== "p2",
    }));
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
