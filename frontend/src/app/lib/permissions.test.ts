import { describe, expect, it } from "vitest";
import {
    NO_ROLE_MODEL,
    ORG_ROLES,
    ORG_ROLE_DESCRIPTIONS,
    ORG_ROLE_LABELS,
    PROJECT_ROLES,
    PROJECT_ROLE_DESCRIPTIONS,
    PROJECT_ROLE_LABELS,
    can,
    creatorScopedAllowed,
    isOrgRole,
    isProjectRole,
    roleFrom,
    roleFromLoaded,
    strongerRole,
    type Capability,
    type ProjectRole,
} from "./permissions";

// Mirror of the backend matrix (backend/src/lib/permissions.ts) — cell by
// cell so any drift between client and server policy is a visible diff.
const EXPECTED: Record<ProjectRole, Record<Capability, boolean>> = {
    viewer: {
        "project.view": true,
        "content.edit": false,
        "docs.organize": false,
        "access.manage": false,
        "container.delete": false,
    },
    member: {
        "project.view": true,
        "content.edit": true,
        // Organizing folders is member work, not an administrative act.
        "docs.organize": true,
        "access.manage": false,
        "container.delete": false,
    },
    admin: {
        "project.view": true,
        "content.edit": true,
        "docs.organize": true,
        "access.manage": true,
        "container.delete": true,
    },
};

describe("permissions matrix (client mirror)", () => {
    for (const [role, caps] of Object.entries(EXPECTED)) {
        for (const [capability, allowed] of Object.entries(caps)) {
            it(`${role} ${allowed ? "can" : "cannot"} ${capability}`, () => {
                expect(
                    can(role as ProjectRole, capability as Capability),
                ).toBe(allowed);
            });
        }
    }

    it("fails closed on missing roles", () => {
        expect(can(null, "project.view")).toBe(false);
        expect(can(undefined, "container.delete")).toBe(false);
    });

    it("has exactly three project roles and two organization roles", () => {
        expect(PROJECT_ROLES).toEqual(["admin", "member", "viewer"]);
        expect(ORG_ROLES).toEqual(["admin", "member"]);
    });
});

describe("role vocabulary", () => {
    it("never says Owner, Manager or Editor", () => {
        const words = [
            ...Object.values(PROJECT_ROLE_LABELS),
            ...Object.values(ORG_ROLE_LABELS),
            ...Object.values(PROJECT_ROLE_DESCRIPTIONS),
            ...Object.values(ORG_ROLE_DESCRIPTIONS),
        ].join(" ");
        expect(words).not.toMatch(/owner|manager|editor/i);
    });

    it("labels every role the product exposes", () => {
        expect(PROJECT_ROLES.map((r) => PROJECT_ROLE_LABELS[r])).toEqual([
            "Admin",
            "Member",
            "Viewer",
        ]);
        expect(ORG_ROLES.map((r) => ORG_ROLE_LABELS[r])).toEqual([
            "Admin",
            "Member",
        ]);
    });
});

describe("strongerRole", () => {
    it("lets an overlapping grant add standing but never subtract it", () => {
        expect(strongerRole("admin", "viewer")).toBe("admin");
        expect(strongerRole("viewer", "admin")).toBe("admin");
        expect(strongerRole("member", "viewer")).toBe("member");
    });

    it("treats absent roles as no claim at all", () => {
        expect(strongerRole(null, "member")).toBe("member");
        expect(strongerRole("member", null)).toBe("member");
        expect(strongerRole(null, null)).toBeNull();
    });
});

describe("NO_ROLE_MODEL", () => {
    it("allows every capability, for surfaces that genuinely have no role", () => {
        // DocTable's `canDo` used to be optional and default to allow-all, so
        // a project surface that forgot to thread its role got a fully open
        // table and looked exactly like the library, which legitimately has
        // no role. The prop is required now and the library says so out loud
        // — this pins that saying so still opens everything it used to.
        for (const capability of [
            "project.view",
            "content.edit",
            "docs.organize",
            "access.manage",
            "container.delete",
        ] as Capability[]) {
            expect(NO_ROLE_MODEL(capability)).toBe(true);
        }
    });
});

describe("creatorScopedAllowed", () => {
    it("lets the creator through and nobody else while they exist", () => {
        expect(creatorScopedAllowed("u1", "u1", false)).toBe(true);
        // An admin does NOT get to reach into a colleague's versions. The
        // client used to claim otherwise — "Only an admin can delete document
        // versions" — about a rule no admin can satisfy.
        expect(creatorScopedAllowed("u1", "u2", true)).toBe(false);
    });

    it("hands the row to container.delete only once the creator is gone", () => {
        // Deleting an account blanks the creator column; without this arm the
        // versions would be unreachable forever.
        expect(creatorScopedAllowed(null, "u2", true)).toBe(true);
        expect(creatorScopedAllowed(null, "u2", false)).toBe(false);
        expect(creatorScopedAllowed(undefined, "u2", true)).toBe(true);
    });

    it("refuses a viewer whose own identity is unknown", () => {
        expect(creatorScopedAllowed("u1", null, true)).toBe(false);
        expect(creatorScopedAllowed("u1", undefined, false)).toBe(false);
    });

    it("models document delete, which has no admin arm at all", () => {
        // DELETE /single-documents/:id selects `.eq("user_id", userId)` with
        // no access check of any kind, so it is creator-scoped with the third
        // argument pinned false: an uploaderless row is deletable by nobody,
        // and a project admin cannot reach a colleague's document.
        expect(creatorScopedAllowed("u1", "u1", false)).toBe(true);
        expect(creatorScopedAllowed("u1", "u2", false)).toBe(false);
        expect(creatorScopedAllowed(null, "u2", false)).toBe(false);
        expect(creatorScopedAllowed(undefined, undefined, false)).toBe(false);
    });
});

describe("roleFrom", () => {
    it("prefers access_role, which both detail and list rows now carry", () => {
        expect(roleFrom({ access_role: "viewer", is_owner: false })).toBe(
            "viewer",
        );
        expect(roleFrom({ access_role: "admin", is_owner: false })).toBe(
            "admin",
        );
    });

    it("falls back to the is_owner provenance flag", () => {
        expect(roleFrom({ is_owner: true })).toBe("admin");
        expect(roleFrom({ is_owner: false })).toBe("member");
    });

    it("fails closed when a row carries neither field", () => {
        // Bare mutation responses (PATCH handlers return the raw DB row)
        // have neither access_role nor is_owner. Defaulting to the top role
        // here once let a client's gates silently open after a column save;
        // the unknown case must resolve to the weakest role.
        expect(roleFrom({})).toBe("viewer");
        expect(roleFrom({ access_role: null, is_owner: null })).toBe("viewer");
    });

    it("ignores role values that are no longer in the ladder", () => {
        // "manager" and "editor" were removed; a stale payload must not
        // resolve to something the matrix cannot rank.
        expect(roleFrom({ access_role: "manager", is_owner: false })).toBe(
            "member",
        );
        expect(roleFrom({ access_role: "owner" })).toBe("viewer");
    });

    it("rejects Object.prototype keys as roles", () => {
        // The role guard used `value in ROLE_RANK`, and `in` walks the
        // prototype chain, so "toString"/"constructor"/"valueOf" all passed
        // and were handed on as if they were real roles. Every one of these
        // must fall through to the fail-closed branch.
        for (const key of [
            "toString",
            "constructor",
            "valueOf",
            "hasOwnProperty",
            "__proto__",
        ]) {
            expect(isProjectRole(key)).toBe(false);
            expect(roleFrom({ access_role: key })).toBe("viewer");
            expect(can(key as ProjectRole, "project.view")).toBe(false);
            expect(strongerRole(key as ProjectRole, null)).toBeNull();
        }
        // is_owner still decides when access_role is junk rather than absent.
        expect(roleFrom({ access_role: "toString", is_owner: true })).toBe(
            "admin",
        );
    });

    it("reports an unloaded row as unknown, not as admin", () => {
        // Every surface used to spell this `row ? roleFrom(row) : "admin"`,
        // which handed the top of the ladder to the caller for the whole
        // load window. Unknown is its own answer and grants nothing.
        expect(roleFromLoaded(null)).toBeNull();
        expect(roleFromLoaded(undefined)).toBeNull();
        for (const capability of [
            "project.view",
            "content.edit",
            "docs.organize",
            "access.manage",
            "container.delete",
        ] as Capability[]) {
            expect(can(roleFromLoaded(null), capability)).toBe(false);
        }
        // A row that has arrived resolves exactly as roleFrom does.
        expect(roleFromLoaded({ access_role: "member" })).toBe("member");
        expect(roleFromLoaded({ is_owner: true })).toBe("admin");
        expect(roleFromLoaded({})).toBe("viewer");
    });

    it("accepts every real role", () => {
        for (const role of PROJECT_ROLES) expect(isProjectRole(role)).toBe(true);
        expect(isProjectRole(null)).toBe(false);
        expect(isProjectRole(undefined)).toBe(false);
        expect(isProjectRole(1)).toBe(false);
    });

    it("guards organization roles the same way", () => {
        // Same exposure as isProjectRole: this reads `<select>` values in the
        // organizations settings page before they are sent as an invitation's
        // role, so it has to refuse everything that is not one of the two.
        for (const role of ORG_ROLES) expect(isOrgRole(role)).toBe(true);
        for (const value of [
            "viewer",
            "owner",
            "toString",
            "constructor",
            null,
            undefined,
            2,
        ]) {
            expect(isOrgRole(value)).toBe(false);
        }
    });
});
