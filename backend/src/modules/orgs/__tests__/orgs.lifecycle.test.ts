import { describe, expect, it, vi } from "vitest";
import {
    listDeletedOrganizations,
    purgeExpiredOrganizations,
    restoreOrganization,
} from "../orgs.lifecycle";

describe("organization lifecycle service", () => {
    it.each([
        ["P0002", "not_found"],
        ["22P02", "not_found"],
        ["42501", "forbidden"],
        ["23514", "conflict"],
        ["XX000", "error"],
    ])("maps database refusal %s to %s", async (code, kind) => {
        const db = {
            rpc: vi.fn(async () => ({
                error: { code, message: "database detail" },
            })),
        };
        const result = await restoreOrganization(db as never, "org", "actor");
        expect(result).toMatchObject({ ok: false, kind });
        if (!result.ok && result.kind !== "error")
            expect(result.detail).not.toContain("database detail");
    });
    it("restores through the transaction with the authenticated actor", async () => {
        const db = { rpc: vi.fn(async () => ({ data: null, error: null })) };
        expect(await restoreOrganization(db as never, "org", "actor")).toEqual({
            ok: true,
            data: null,
        });
        expect(db.rpc).toHaveBeenCalledWith("restore_organization", {
            p_org_id: "org",
            p_actor_id: "actor",
        });
    });
    it("lists only owned, deleted organizations whose recovery deadline is still in the future", async () => {
        const calls: unknown[][] = [];
        const organization = {
            id: "org",
            name: "Firm",
            deleted_at: "2026-10-01",
            purge_after: "2026-10-31",
        };
        const query: Record<string, unknown> = {
            then: (resolve: (r: unknown) => void) =>
                resolve({
                    data: [{ organizations: organization }],
                    error: null,
                }),
        };
        for (const method of ["select", "eq", "not", "gt"])
            query[method] = (...args: unknown[]) => {
                calls.push([method, ...args]);
                return query;
            };
        const result = await listDeletedOrganizations(
            { from: () => query } as never,
            "actor",
        );
        expect(result).toEqual({ ok: true, data: [organization] });
        expect(calls).toContainEqual(["eq", "user_id", "actor"]);
        expect(calls).toContainEqual(["eq", "role", "owner"]);
        expect(calls).toContainEqual([
            "not",
            "organizations.deleted_at",
            "is",
            null,
        ]);
        expect(calls).toContainEqual([
            "gt",
            "organizations.purge_after",
            expect.any(String),
        ]);
    });
    it("propagates purge errors to maintenance and returns successful batch counts", async () => {
        const rpc = vi
            .fn()
            .mockResolvedValueOnce({ error: { message: "database detail" } })
            .mockResolvedValueOnce({ data: 2 });
        await expect(
            purgeExpiredOrganizations({ rpc } as never),
        ).rejects.toThrow("Could not purge expired organizations");
        expect(await purgeExpiredOrganizations({ rpc } as never)).toBe(2);
    });
});
