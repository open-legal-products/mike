import { describe, expect, it } from "vitest";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import { comparisonWithPrevious, versionLabel } from "./versionComparison";

const version = (id: string, n: number | null, extra: Partial<DocumentVersion> = {}): DocumentVersion => ({
    id, version_number: n, source: "upload", created_at: "2026-11-01", filename: "MSA.docx", file_type: "docx", ...extra,
});

describe("comparisonWithPrevious", () => {
    it("pairs the displayed version with the one just before it, whatever order they arrive in", () => {
        const versions = [version("v3", 3), version("v1", 1), version("v2", 2)];
        expect(comparisonWithPrevious(versions, "v3")).toMatchObject({ base: { id: "v2" }, target: { id: "v3" } });
        expect(comparisonWithPrevious(versions, "v2")).toMatchObject({ base: { id: "v1" }, target: { id: "v2" } });
    });

    it("has nothing to offer for the first version", () => {
        expect(comparisonWithPrevious([version("v1", 1), version("v2", 2)], "v1")).toBeNull();
    });

    it("skips deleted versions and versions that are not Word documents", () => {
        const versions = [
            version("v1", 1),
            version("v2", 2, { file_type: "pdf", filename: "MSA.pdf" }),
            version("v3", 3, { deleted_at: "2026-11-02" }),
            version("v4", 4),
        ];
        expect(comparisonWithPrevious(versions, "v4")).toMatchObject({ base: { id: "v1" } });
        expect(comparisonWithPrevious(versions, "v2")).toBeNull();
        expect(comparisonWithPrevious(versions, "v3")).toBeNull();
    });

    it("recognises Word versions saved before file_type existed by their filename", () => {
        const versions = [version("v1", 1, { file_type: undefined }), version("v2", 2, { file_type: null, filename: "MSA Final.DOCX" })];
        expect(comparisonWithPrevious(versions, "v2")).toMatchObject({ base: { id: "v1" } });
    });

    it("does not guess an order for versions without a number or an unknown selection", () => {
        expect(comparisonWithPrevious([version("v1", 1), version("vx", null)], "vx")).toBeNull();
        expect(comparisonWithPrevious([version("v1", 1), version("v2", 2)], "missing")).toBeNull();
    });
});

it("labels a version for the menu and the title row", () => {
    expect(versionLabel(version("v2", 2))).toBe("V2");
    expect(versionLabel(version("vx", null))).toBe("an earlier version");
});
