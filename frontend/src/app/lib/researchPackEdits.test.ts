// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    appendMikeEditRevision,
    editableFields,
    exportMikeEditPackage,
    mikeEditBaseFile,
    verifyMikeEditPackage,
    verifyMikeEditPackageFile,
    verifyMikeEditPackageSource,
    withEditableFields,
} from "./researchPackEdits";

const filename = "assessment-context-r2.research-pack.json";
const originalText = readFileSync(
    resolve("../tests/fixtures/research-workspace-portable-v02", filename),
    "utf8",
);
const pack = JSON.parse(originalText);

async function openedPack() {
    const file = new File([originalText], filename, { type: "application/json" });
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const inputSha = Array.from(new Uint8Array(digest), (part) =>
        part.toString(16).padStart(2, "0"),
    ).join("");
    return {
        file,
        pack,
        report: { integrity: "pass" as const, input_sha256: inputSha },
    };
}

describe("Mike edit package", () => {
    it("preserves the imported pack and verifies an append-only edit history", async () => {
        const opened = await openedPack();
        const baseRevision = opened.pack.revisions.find(
            (item: { revision: number }) => item.revision === opened.pack.selected_revision,
        )!;
        const before = JSON.stringify(opened.pack);
        const firstEdits = editableFields(baseRevision);
        firstEdits.findingText = "A locally edited finding.";
        firstEdits.assessments[0].note = "A local annotation.";

        const first = await appendMikeEditRevision(
            opened,
            opened.pack.selected_revision,
            firstEdits,
            null,
        );
        const secondEdits = { ...firstEdits, findingText: "A later local finding." };
        const second = await appendMikeEditRevision(
            opened,
            opened.pack.selected_revision,
            secondEdits,
            first,
        );
        const verified = await verifyMikeEditPackage(second);
        const exported = await verifyMikeEditPackageFile(
            new File([exportMikeEditPackage(verified)], "edited.json", { type: "application/json" }),
        );
        await verifyMikeEditPackageSource(exported, opened);

        expect(exported.local_revisions).toHaveLength(2);
        expect(exported.local_revisions[1].parent_sha256).toBe(
            exported.local_revisions[0].content_sha256,
        );
        expect(exported.local_revisions[1].edits.findingText).toBe("A later local finding.");
        expect(await mikeEditBaseFile(exported).text()).toBe(originalText);
        expect(withEditableFields(baseRevision, exported.local_revisions[1].edits).finding)
            .toMatchObject({ text: "A later local finding." });
        expect(JSON.stringify(opened.pack)).toBe(before);
        expect(exported.authenticity).toBe("not_established");
    });

    it("refuses an edit whose bytes no longer match the package digest", async () => {
        const opened = await openedPack();
        const revision = opened.pack.revisions.find(
            (item: { revision: number }) => item.revision === opened.pack.selected_revision,
        )!;
        const edits = editableFields(revision);
        const packageValue = await appendMikeEditRevision(
            opened,
            opened.pack.selected_revision,
            edits,
            null,
        );
        const altered = structuredClone(packageValue);
        altered.local_revisions[0].edits.findingText = "Altered after export.";
        await expect(verifyMikeEditPackage(altered)).rejects.toThrow(/package integrity mismatch/);
    });
});
