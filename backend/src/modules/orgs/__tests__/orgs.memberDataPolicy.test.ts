import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    role: null as string | null,
    recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    getOrgRole: vi.fn(async () => mocks.role),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: mocks.recordAudit }));

import {
    memberDataActionAllowed,
    setOrgMemberDataPolicy,
} from "../orgs.memberDataPolicy";

type Row = Record<string, unknown>;

/** One organizations row; reads see it, updates change it. */
function fakeDb(row: Row | null, readError: { message: string } | null = null) {
    const updates: Row[] = [];
    const db = {
        from: (table: string) => {
            expect(table).toBe("organizations");
            let patch: Row | null = null;
            const q: Record<string, unknown> = {
                select: () => q,
                eq: () => q,
                update: (value: Row) => {
                    patch = value;
                    return q;
                },
                maybeSingle: async () => ({ data: readError || !row ? null : { ...row }, error: readError }),
                then: (resolve: (v: unknown) => unknown) => {
                    if (patch && row) {
                        updates.push(patch);
                        Object.assign(row, patch);
                    }
                    return Promise.resolve({ data: row ? [{ id: "org-1" }] : [], error: null }).then(resolve);
                },
            };
            return q;
        },
    };
    return { db: db as never, updates };
}

beforeEach(() => {
    mocks.role = null;
    mocks.recordAudit.mockClear();
});

describe("memberDataActionAllowed", () => {
    it("always lets an owner", async () => {
        mocks.role = "owner";
        const { db } = fakeDb({ allow_member_exports: false, allow_member_deletes: false });
        await expect(memberDataActionAllowed(db, "u1", "org-1", "export")).resolves.toBe(true);
        await expect(memberDataActionAllowed(db, "u1", "org-1", "delete")).resolves.toBe(true);
    });

    it("lets other members only what the organization allows", async () => {
        mocks.role = "admin";
        const { db } = fakeDb({ allow_member_exports: true, allow_member_deletes: false });
        await expect(memberDataActionAllowed(db, "u1", "org-1", "export")).resolves.toBe(true);
        await expect(memberDataActionAllowed(db, "u1", "org-1", "delete")).resolves.toBe(false);
    });

    it("refuses someone who is not a member", async () => {
        const { db } = fakeDb({ allow_member_exports: true, allow_member_deletes: true });
        await expect(memberDataActionAllowed(db, "u1", "org-1", "export")).resolves.toBe(false);
    });

    it("throws rather than answering when the policy cannot be read", async () => {
        mocks.role = "member";
        const { db } = fakeDb(null, { message: "unavailable" });
        await expect(memberDataActionAllowed(db, "u1", "org-1", "export")).rejects.toThrow(
            "Failed to read the organization's data policy",
        );
    });
});

describe("setOrgMemberDataPolicy", () => {
    const set = (db: never, allowExports: unknown, allowDeletes: unknown) =>
        setOrgMemberDataPolicy(db, { actorId: "u1", orgId: "org-1", allowExports, allowDeletes });

    it("is an owner's alone", async () => {
        mocks.role = "admin";
        const { db, updates } = fakeDb({ allow_member_exports: false, allow_member_deletes: false });
        await expect(set(db, true, true)).resolves.toEqual({ ok: false, kind: "owner_required" });
        expect(updates).toEqual([]);
    });

    it("refuses anything but two booleans", async () => {
        mocks.role = "owner";
        const { db, updates } = fakeDb({ allow_member_exports: false, allow_member_deletes: false });
        await expect(set(db, "yes", false)).resolves.toMatchObject({ ok: false, kind: "validation" });
        expect(updates).toEqual([]);
    });

    it("saves both settings and audits only the one that changed", async () => {
        mocks.role = "owner";
        const { db, updates } = fakeDb({ allow_member_exports: false, allow_member_deletes: true });

        await expect(set(db, true, true)).resolves.toEqual({
            ok: true,
            policy: { allow_member_exports: true, allow_member_deletes: true },
        });
        expect(updates[0]).toMatchObject({ allow_member_exports: true, allow_member_deletes: true });
        expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
        expect(mocks.recordAudit).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ action: "org.member_exports.allowed", orgId: "org-1" }),
        );
    });
});
