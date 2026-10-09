import { describe, expect, it } from "vitest";
import {
    can,
    isProjectRole,
    type Capability,
    type ProjectRole,
} from "../permissions";

// The capability matrix is the whole authorization policy, so assert it as a
// table rather than as prose: every role against every capability, with the
// expected verdict written out. A future edit that quietly promotes a
// capability has to change a line here to pass.
const MATRIX: Record<ProjectRole, Record<Capability, boolean>> = {
    viewer: {
        "project.view": true,
        "content.edit": false,
        "docs.organize": false,
        "access.manage": false,
        "container.delete": false,
    },
    editor: {
        "project.view": true,
        "content.edit": true,
        // Folder work is available to editors: a collaborator who
        // may upload and delete documents is not meaningfully restrained by
        // being unable to rename the folder holding them.
        "docs.organize": true,
        "access.manage": false,
        "container.delete": false,
    },
    owner: {
        "project.view": true,
        "content.edit": true,
        "docs.organize": true,
        "access.manage": true,
        "container.delete": true,
    },
};

describe("permissions matrix", () => {
    for (const [role, capabilities] of Object.entries(MATRIX)) {
        for (const [capability, expected] of Object.entries(capabilities)) {
            it(`${role} ${expected ? "can" : "cannot"} ${capability}`, () => {
                expect(
                    can(role as ProjectRole, capability as Capability),
                ).toBe(expected);
            });
        }
    }

    it("fails closed on missing or unknown roles", () => {
        expect(can(null, "project.view")).toBe(false);
        expect(can(undefined, "project.view")).toBe(false);
        // The old ladder's role names must not linger as usable values.
        expect(can("admin" as unknown as ProjectRole, "project.view")).toBe(
            false,
        );
        expect(can("manager" as unknown as ProjectRole, "project.view")).toBe(
            false,
        );
        expect(can("member" as unknown as ProjectRole, "project.view")).toBe(false);
    });

    it("recognises exactly the three project roles", () => {
        expect(isProjectRole("owner")).toBe(true);
        expect(isProjectRole("editor")).toBe(true);
        expect(isProjectRole("viewer")).toBe(true);
        expect(isProjectRole("admin")).toBe(false);
        expect(isProjectRole("manager")).toBe(false);
        expect(isProjectRole("member")).toBe(false);
        expect(isProjectRole(undefined)).toBe(false);
    });
});
