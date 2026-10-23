import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../lib/supabase";

const mocks = vi.hoisted(() => ({ role: vi.fn(), audit: vi.fn() }));
vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    getOrgRole: mocks.role,
}));
vi.mock("../../lib/audit", () => ({ recordAudit: mocks.audit }));

import { getOrgProfile, saveOrgProfile } from "./orgs.profile";

const EMPTY = {
    group_name: null,
    headquarters_jurisdiction: null,
    operating_jurisdictions: [],
    fiscal_year_end: null,
    reporting_currency: null,
    group_structure: null,
    house_positions: null,
    standing_instructions: null,
    reviewed_on: null,
    updated_at: null,
};

const VALID = {
    group_name: "Example Group",
    headquarters_jurisdiction: "NL",
    operating_jurisdictions: ["NL", "DE"],
    fiscal_year_end: "12-31",
    reporting_currency: "EUR",
    group_structure: "Holding in NL with two operating subsidiaries.",
    house_positions: "We do not claim the innovation box.",
    standing_instructions: "Cite Dutch sources first.",
    reviewed_on: "2026-10-18",
};

function database(row: unknown = null) {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ["select", "eq"]) query[name] = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    query.upsert = vi.fn(() => query);
    query.single = vi.fn(async () => ({
        data: { ...VALID, updated_at: "2026-10-18T12:00:00Z" },
        error: null,
    }));
    return { from: vi.fn(() => query), query };
}

const actor = { actorId: "user", orgId: "org" };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.role.mockResolvedValue("owner");
});

describe("getOrgProfile", () => {
    it("returns the empty profile when none is stored", async () => {
        const db = database(null);
        const result = await getOrgProfile(db as unknown as Db, actor);
        expect(result).toEqual({ ok: true, ...EMPTY });
        expect(db.query.eq).toHaveBeenCalledWith("org_id", "org");
    });

    it("lets a member read it", async () => {
        mocks.role.mockResolvedValue("member");
        const db = database({ ...VALID, updated_at: "2026-10-18T12:00:00Z" });
        const result = await getOrgProfile(db as unknown as Db, actor);
        expect(result).toMatchObject({ ok: true, group_name: "Example Group" });
    });

    it("is not found for someone outside the organization", async () => {
        mocks.role.mockResolvedValue(null);
        const db = database(null);
        expect(await getOrgProfile(db as unknown as Db, actor)).toEqual({
            ok: false,
            kind: "not_found",
        });
        expect(db.from).not.toHaveBeenCalled();
    });
});

describe("saveOrgProfile", () => {
    it("is forbidden for a member", async () => {
        mocks.role.mockResolvedValue("member");
        const db = database();
        const result = await saveOrgProfile(db as unknown as Db, { ...actor, body: VALID });
        expect(result).toEqual({ ok: false, kind: "forbidden" });
        expect(db.query.upsert).not.toHaveBeenCalled();
    });

    it.each([
        ["an over-long house position", { ...VALID, house_positions: "x".repeat(4001) }],
        ["a non-string group name", { ...VALID, group_name: 42 }],
        ["a currency that is not three capital letters", { ...VALID, reporting_currency: "euro" }],
        ["more than 100 jurisdictions", { ...VALID, operating_jurisdictions: Array.from({ length: 101 }, () => "NL") }],
        ["a jurisdiction code over 10 characters", { ...VALID, operating_jurisdictions: ["NETHERLANDS1"] }],
        ["a review date that is not a date", { ...VALID, reviewed_on: "yesterday" }],
        ["a body that is not an object", "profile"],
    ])("rejects %s without writing", async (_label, body) => {
        const db = database();
        const result = await saveOrgProfile(db as unknown as Db, { ...actor, body });
        expect(result).toMatchObject({ ok: false, kind: "validation" });
        expect(db.query.upsert).not.toHaveBeenCalled();
        expect(mocks.audit).not.toHaveBeenCalled();
    });

    it("upserts a valid profile and audits without its text", async () => {
        const db = database();
        const result = await saveOrgProfile(db as unknown as Db, {
            ...actor,
            actorEmail: "admin@example.com",
            body: VALID,
        });
        expect(result).toMatchObject({ ok: true, group_name: "Example Group" });
        expect(db.from).toHaveBeenCalledWith("org_profiles");
        expect(db.query.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ org_id: "org", updated_by: "user", ...VALID }),
            { onConflict: "org_id" },
        );
        expect(mocks.audit).toHaveBeenCalledTimes(1);
        const event = mocks.audit.mock.calls[0][1];
        expect(event.action).toBe("org.profile.updated");
        expect(event.detail).toEqual({ org_id: "org" });
    });

    it("stores blank text as null and trims values", async () => {
        const db = database();
        await saveOrgProfile(db as unknown as Db, {
            ...actor,
            body: { ...VALID, group_name: "  Example Group  ", house_positions: "   " },
        });
        expect(db.query.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ group_name: "Example Group", house_positions: null }),
            { onConflict: "org_id" },
        );
    });
});
