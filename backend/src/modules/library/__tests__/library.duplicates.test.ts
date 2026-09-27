import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { findLibraryDocumentDuplicates } from "../library.service";

const hash = (c: string) => c.repeat(64);

describe("findLibraryDocumentDuplicates", () => {
    it("compares only the user's own library documents of this kind", async () => {
        const fake = scriptedDb([
            {
                table: "documents",
                data: [
                    { id: "d1", current_version_id: "v1", library_folder_id: "lf1" },
                    { id: "d2", current_version_id: "v2", library_folder_id: null },
                ],
            },
            {
                table: "document_versions",
                data: [
                    { id: "v1", filename: "Muster.docx", content_sha256: hash("a") },
                    // Same bytes in another user's library: not a candidate.
                    { id: "vx", filename: "Fremd.docx", content_sha256: hash("a") },
                ],
            },
        ]);

        const result = await findLibraryDocumentDuplicates(fake.db, "u1", "file", [
            hash("a"),
        ]);

        expect(result).toEqual({
            ok: true,
            data: {
                [hash("a")]: [{ id: "d1", filename: "Muster.docx", folder_id: "lf1" }],
            },
        });
        expect(fake.calls[0].filters).toEqual([
            ["eq", "user_id", "u1"],
            ["is", "project_id", null],
            ["or", "library_kind.eq.file,library_kind.is.null"],
        ]);
        fake.done();
    });

    it("scopes templates by their kind", async () => {
        const fake = scriptedDb([
            { table: "documents", data: [] },
        ]);
        await findLibraryDocumentDuplicates(fake.db, "u1", "template", [hash("b")]);
        expect(fake.calls[0].filters).toContainEqual(["eq", "library_kind", "template"]);
        fake.done();
    });

    it("rejects malformed hashes without querying", async () => {
        const fake = scriptedDb([]);
        const result = await findLibraryDocumentDuplicates(fake.db, "u1", "file", ["nope"]);
        expect(result).toMatchObject({ ok: false, status: 400 });
        fake.done();
    });
});
