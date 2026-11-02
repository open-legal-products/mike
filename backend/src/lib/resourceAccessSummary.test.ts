import { describe, expect, it, vi } from "vitest";
import { ensureResourceAccessSummaries } from "./resourceAccessSummary";

describe("ensureResourceAccessSummaries", () => {
  // An organization's item is private until it is opened to everyone. The
  // helper once took "private, but in an organization" for a row an older
  // query had left incomplete, and rewrote it — and every other row on the
  // page — as public.
  it.each([
    {
      kind: "project" as const,
      overrideTable: "project_org_access_overrides",
      resourceKey: "project_id",
    },
    {
      kind: "workflow" as const,
      overrideTable: "workflow_org_access_overrides",
      resourceKey: "workflow_id",
    },
  ])(
    "leaves an organization's private and shared $kind rows as the query labelled them",
    async ({ kind, overrideTable, resourceKey }) => {
      const tables: Record<string, unknown[]> = {
        [overrideTable]: [
          { [resourceKey]: "shared-1", role: "owner" },
          { [resourceKey]: "shared-1", role: "viewer" },
          // Walling somebody off is not sharing with them.
          { [resourceKey]: "shared-1", role: "deny" },
        ],
      };
      const from = vi.fn((table: string) => ({
        select: () => ({
          in: async () => ({ data: tables[table] ?? [], error: null }),
        }),
      }));
      const rows = [
        {
          id: "public-1",
          org_id: "org-1",
          access_scope: "organization",
          organization_name: "Acme LLP",
        },
        { id: "private-1", org_id: "org-1", access_scope: "private" },
        { id: "shared-1", org_id: "org-1", access_scope: "shared" },
      ];

      const result = await ensureResourceAccessSummaries(
        { from } as never,
        kind,
        rows,
      );

      expect(result.error).toBeNull();
      expect(result.rows).toEqual([
        rows[0],
        rows[1],
        { ...rows[2], direct_grant_count: 2 },
      ]);
      // The rows were complete: nothing is re-read to "repair" them.
      expect(from.mock.calls.map(([table]) => table)).not.toContain(
        kind === "project" ? "projects" : "workflows",
      );
      expect(from).toHaveBeenCalledWith(overrideTable);
    },
  );

  it("asks nothing when an organization's rows are public or private", async () => {
    const from = vi.fn();
    const rows = [
      {
        id: "public-1",
        org_id: "org-1",
        access_scope: "organization",
        organization_name: "Acme LLP",
      },
      { id: "private-1", org_id: "org-1", access_scope: "private" },
    ];
    await expect(
      ensureResourceAccessSummaries({ from } as never, "project", rows),
    ).resolves.toEqual({ rows, error: null });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "project" as const,
      grantTable: "project_access_grants",
      resourceKey: "project_id",
    },
    {
      kind: "workflow" as const,
      grantTable: "workflow_shares",
      resourceKey: "workflow_id",
    },
  ])(
    "counts direct $kind grants without making per-resource requests",
    async ({ kind, grantTable, resourceKey }) => {
      const grants = [
        { [resourceKey]: "shared-1" },
        { [resourceKey]: "shared-1" },
        { [resourceKey]: "shared-2" },
      ];
      const inQuery = vi.fn().mockResolvedValue({ data: grants, error: null });
      const select = vi.fn().mockReturnValue({ in: inQuery });
      const from = vi.fn().mockReturnValue({ select });

      const result = await ensureResourceAccessSummaries(
        { from } as never,
        kind,
        [
          { id: "shared-1", org_id: null, access_scope: "shared" },
          { id: "shared-2", org_id: null, access_scope: "shared" },
          { id: "private-1", org_id: null, access_scope: "private" },
        ],
      );

      expect(result.error).toBeNull();
      expect(result.rows).toEqual([
        {
          id: "shared-1",
          org_id: null,
          access_scope: "shared",
          direct_grant_count: 2,
        },
        {
          id: "shared-2",
          org_id: null,
          access_scope: "shared",
          direct_grant_count: 1,
        },
        { id: "private-1", org_id: null, access_scope: "private" },
      ]);
      expect(from).toHaveBeenCalledOnce();
      expect(from).toHaveBeenCalledWith(grantTable);
      expect(select).toHaveBeenCalledWith(resourceKey);
      expect(inQuery).toHaveBeenCalledWith(resourceKey, [
        "shared-1",
        "shared-2",
        "private-1",
      ]);
    },
  );
});
