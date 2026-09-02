import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The review asked for one role vocabulary — Admin, Member, Viewer — and
 * `permissions.test.ts` already fails the build if a user-facing *label* says
 * otherwise. That check cannot see comments, and comments are where the old
 * vocabulary survived: TabularReviewView still explained its gates in terms
 * of "manager+", "non-managers" and "Managers and the owner" long after the
 * tier had been deleted, so the next person to read those gates would learn
 * a ladder the product does not have and reason from it.
 *
 * "Manager" has no legitimate meaning anywhere in this codebase — unlike
 * "owner" (`is_owner`, `owner_email`) and "editor" (text editors), both of
 * which are real, current words. So it is banned outright in the files that
 * describe the permission model, prose included.
 *
 * A deliberate history note escapes by bracketing itself in
 * `[retired-vocabulary] … [/retired-vocabulary]`, which makes "I am
 * describing the model we removed" an explicit claim rather than something a
 * reader has to infer.
 */
const ROOT = join(__dirname, "../..");

const PERMISSION_SURFACES = [
    "app/lib/permissions.ts",
    "app/components/popups/PermissionDeniedPopup.tsx",
    "app/components/modals/PeopleModal.tsx",
    "app/components/projects/ProjectWorkspace.tsx",
    "app/components/projects/ProjectsOverview.tsx",
    "app/components/projects/ProjectDocumentsView.tsx",
    "app/components/projects/ProjectPageParts.tsx",
    "app/components/documents/DocTable.tsx",
    "app/components/tabular/TabularReviewView.tsx",
    "app/components/tabular/TRChatPanel.tsx",
    "app/components/shared/SidebarChatItem.tsx",
    "app/components/shared/AddUserInput.tsx",
];

const RETIRED = /\bmanagers?\b/i;

/** Strip the bracketed history notes before scanning. */
function withoutHistoryNotes(source: string) {
    return source.replace(
        /\[retired-vocabulary\][\s\S]*?\[\/retired-vocabulary\]/g,
        "",
    );
}

describe("role vocabulary in the permission surfaces", () => {
    for (const relative of PERMISSION_SURFACES) {
        it(`${relative} never says Manager`, () => {
            const source = withoutHistoryNotes(
                readFileSync(join(ROOT, relative), "utf8"),
            );
            const offenders = source
                .split("\n")
                .map((line, index) => [index + 1, line] as const)
                .filter(([, line]) => RETIRED.test(line));
            expect(offenders).toEqual([]);
        });
    }

    it("still catches a retired word outside a history note", () => {
        // Guards the guard: without this, a broken regex would leave every
        // case above passing vacuously.
        expect(RETIRED.test("// structural, manager+")).toBe(true);
        expect(RETIRED.test("// stop non-managers before the modal")).toBe(true);
        // …and does not fire on the words that are legitimately current.
        expect(RETIRED.test('can(role, "access.manage")')).toBe(false);
        expect(RETIRED.test("onManageAccess, management")).toBe(false);
        expect(
            RETIRED.test(
                withoutHistoryNotes(
                    "[retired-vocabulary] owner/manager/editor [/retired-vocabulary]",
                ),
            ),
        ).toBe(false);
    });
});
