import { describe, expect, it } from "vitest";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import { versionComparisons, versionLabel } from "./versionComparison";

const version = (id: string, n: number | null, extra: Partial<DocumentVersion> = {}): DocumentVersion => ({
    id, version_number: n, source: "upload", created_at: "2026-11-01", filename: "MSA.docx", file_type: "docx", ...extra,
});

describe("versionComparisons", () => {
    it("offers all other Word versions newest first and keeps the displayed version as target", () => {
        const [v3, v1, v2] = [version("v3", 3), version("v1", 1), version("v2", 2)];
        expect(versionComparisons([v3, v1, v2], "v3")).toEqual([
            { base: v2, target: v3 }, { base: v1, target: v3 },
        ]);
        expect(versionComparisons([v3, v1, v2], "v1")).toEqual([
            { base: v3, target: v1 }, { base: v2, target: v1 },
        ]);
        expect(versionComparisons([v1], "v1")).toEqual([]);
    });

    it("skips deleted versions and versions that are not Word documents", () => {
        const versions = [
            version("v1", 1),
            version("v2", 2, { file_type: "pdf", filename: "MSA.pdf" }),
            version("v3", 3, { deleted_at: "2026-11-02" }),
            version("v4", 4),
        ];
        expect(versionComparisons(versions, "v4")).toMatchObject([{ base: { id: "v1" } }]);
        expect(versionComparisons(versions, "v2")).toEqual([]);
        expect(versionComparisons(versions, "v3")).toEqual([]);
    });

    it("recognises Word versions saved before file_type existed by their filename", () => {
        const versions = [version("v1", 1, { file_type: undefined }), version("v2", 2, { file_type: null, filename: "MSA Final.DOCX" })];
        expect(versionComparisons(versions, "v2")).toMatchObject([{ base: { id: "v1" } }]);
    });

    it("supports unnumbered legacy versions and ignores a missing selection", () => {
        expect(versionComparisons([version("v1", 1), version("vx", null)], "vx")).toMatchObject([{ base: { id: "v1" }, target: { id: "vx" } }]);
        expect(versionComparisons([version("v1", 1), version("v2", 2)], "missing")).toEqual([]);
    });
});

it("labels a version for the menu and the title row", () => {
    expect(versionLabel(version("v2", 2))).toBe("V2");
    expect(versionLabel(version("vx", null))).toBe("version from 2026-11-01");
});
