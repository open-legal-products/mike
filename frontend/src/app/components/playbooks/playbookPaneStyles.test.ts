import { describe, expect, it } from "vitest";
import { EDITOR_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { PLAYBOOK_PANE_SURFACE_CLASS } from "./playbookPaneStyles";

describe("playbook pane surface", () => {
    it("is the editor card, marked so a page sheet can set it flat", () => {
        // globals.css clears `.playbook-pane` on a sheet from md up.
        expect(PLAYBOOK_PANE_SURFACE_CLASS.split(" ")).toEqual(
            expect.arrayContaining([
                "playbook-pane",
                ...EDITOR_SURFACE_CLASS.split(" "),
            ]),
        );
    });
});
