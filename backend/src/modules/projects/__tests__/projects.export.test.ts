import { describe, expect, it } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { buildProjectExportManifest } from "../projects.export";

const stamp = (i: number) => `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`;

/** A project with `count` documents, two versions and one edit each. */
function project(count: number) {
    const ids = Array.from({ length: count }, (_, i) => `d${String(i).padStart(3, "0")}`);
    return {
        ids,
        tables: {
            projects: [{ id: "p1", name: "Matter", cm_number: null, created_at: stamp(0) }],
            memory_files: [{ id: "m1", scope: "project", project_id: "p1", enabled: true, epoch: 0, revision: 1, content: "# Memory", content_sha256: null, size_bytes: 8, status: "idle" }],
            // Inserted newest-first so the manifest's order is the sort's, not the table's.
            documents: ids.map((id, i) => ({ id, project_id: "p1", status: "ready", current_version_id: `${id}-v2`, created_at: stamp(i) })).reverse(),
            document_versions: ids.flatMap((id, i) => [2, 1].map((n) => ({ id: `${id}-v${n}`, document_id: id, version_number: n, source: "upload", filename: `${id}.docx`, file_type: "docx", size_bytes: 1, content_sha256: `${id}-${n}`, deleted_at: null, created_at: stamp(i * 2 + n) }))),
            document_edits: ids.map((id, i) => ({ id: `${id}-e1`, document_id: id, version_id: `${id}-v2`, change_id: "c", status: "accepted", created_at: stamp(i), resolved_at: null })),
        },
    };
}

describe("project export manifest", () => {
    it("lists a large project completely behind a gateway row cap and URL-length limit, in creation order", async () => {
        const { ids, tables } = project(120);
        // 7 rows per response: far below the 1000 the reader asks for, as a
        // gateway with a lower max_rows (or a proxy) behaves. 50 ids per
        // `.in()` is the URL-length budget.
        const fake = tableDb(tables, { maxRows: 7, maxInList: 50 });
        const manifest = await buildProjectExportManifest(fake.db, "p1");

        expect(manifest.documents.map((d) => d.id)).toEqual(ids);
        expect(manifest.documents.every((d) => d.versions.map((v) => v.version_number).join() === "1,2")).toBe(true);
        expect(manifest.documents.every((d) => d.edits.length === 1)).toBe(true);
        expect(manifest.memory.markdown).toBe("# Memory");
        expect(Math.max(...fake.calls.flatMap((call) => call.inSizes))).toBeLessThanOrEqual(50);
        expect(Math.max(...fake.calls.map((call) => call.returned))).toBeLessThanOrEqual(7);
    });

    it("fails rather than sealing a manifest with a table missing", async () => {
        const { tables } = project(3);
        const fake = tableDb(tables, { failSelects: ["document_versions"] });
        await expect(buildProjectExportManifest(fake.db, "p1")).rejects.toThrow(/document_versions/);
    });
});
