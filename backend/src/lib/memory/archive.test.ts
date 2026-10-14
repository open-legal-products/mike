import { describe, expect, it, vi } from "vitest";

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

describe("buildMemoryArchive", () => {
  it("includes the caller's own memories and currently accessible project Markdown without unsafe paths", async () => {
    listAccessibleProjectIds.mockResolvedValue(["p1", "p2"]);
    checkProjectAccess.mockImplementation(async (projectId: string) => ({
      ok: projectId === "p1",
    }));
    getMemoryCurrent.mockImplementation(
      async (_db: unknown, scope: string, ownerId: string) => ({
        current: {
          content:
            scope === "user" ? "# App memory" : `# Project ${ownerId}`,
        },
      }),
    );
    const rows: Record<string, unknown[]> = {
      projects: [
        { id: "p2", name: "Revoked" },
        { id: "p1", name: "../Matter/Alpha" },
      ],
      // The caller's own memory in an organization they belong to.
      memory_files: [{ org_id: "org-1", content: "# Learned at the firm" }],
      organizations: [{ id: "org-1", name: "Acme/../LLP" }],
    };
    const db = {
      from: vi.fn((table: string) => {
        const result = { data: rows[table] ?? [], error: null };
        const builder: Record<string, unknown> = {
          then: (resolve: (value: typeof result) => unknown) => resolve(result),
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

    const buffer = await buildMemoryArchive(
      db as never,
      "u1",
      "u1@example.test",
    );
    const zip = await JSZip.loadAsync(buffer);
    const fileNames = Object.keys(zip.files).filter(
      (name) => !zip.files[name].dir,
    );
    const projectFile = fileNames.find((name) => name.includes("--p1/"));

    expect(await zip.file("app/memory.md")?.async("string")).toBe(
      "# App memory",
    );
    // One file per organization, beside Personal, under a path that cannot
    // climb out of the archive.
    const workspaceFile = fileNames.find((name) =>
      name.startsWith("organizations/"),
    );
    expect(workspaceFile).toMatch(/^organizations\/[^/]+--org-1\/memory\.md$/);
    expect(workspaceFile).not.toContain("..");
    expect(await zip.file(workspaceFile!)?.async("string")).toBe(
      "# Learned at the firm",
    );
    expect(projectFile).toBeTruthy();
    expect(projectFile).not.toContain("..");
    expect(projectFile).not.toContain("\\");
    expect(await zip.file(projectFile!)?.async("string")).toBe("# Project p1");
    expect(fileNames.some((name) => name.includes("--p2/"))).toBe(false);
    expect(getMemoryCurrent).not.toHaveBeenCalledWith(
      db,
      "project",
      "p2",
      true,
    );
  });
});
