import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
    matchDocumentsByContentHash,
    parseContentHashes,
} from "../documents.duplicates";

const hash = (c: string) => c.repeat(64);

describe("parseContentHashes", () => {
    it("accepts and de-duplicates lower-case SHA-256 hex", () => {
        expect(parseContentHashes([hash("a"), hash("a"), hash("b")])).toEqual([
            hash("a"),
            hash("b"),
        ]);
        expect(parseContentHashes([])).toEqual([]);
    });

    it.each([
        ["not an array", "x"],
        ["malformed", ["xyz"]],
        ["upper case", ["A".repeat(64)]],
        ["too many", Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, "0"))],
    ])("rejects %s", (_label, value) => {
        expect(parseContentHashes(value)).toBeNull();
    });
});

describe("matchDocumentsByContentHash", () => {
    it("matches only current versions of the candidates", async () => {
        const fake = scriptedDb([
            {
                table: "document_versions",
                data: [
                    { id: "v1", filename: "A.pdf", content_sha256: hash("a") },
                    { id: "old", filename: "Old.pdf", content_sha256: hash("a") },
                ],
            },
        ]);
        const result = await matchDocumentsByContentHash(
            fake.db,
            [
                { id: "d1", current_version_id: "v1", folder_id: null },
                { id: "d2", current_version_id: null, folder_id: null },
            ],
            [hash("a")],
        );
        expect(result).toEqual({
            ok: true,
            matches: { [hash("a")]: [{ id: "d1", filename: "A.pdf", folder_id: null }] },
        });
        fake.done();
    });

    it("does not query without candidates or hashes", async () => {
        const fake = scriptedDb([]);
        expect(await matchDocumentsByContentHash(fake.db, [], [hash("a")])).toEqual({
            ok: true,
            matches: {},
        });
        fake.done();
    });

    it("passes a query error through", async () => {
        const error = new Error("db down");
        const fake = scriptedDb([{ table: "document_versions", error }]);
        expect(
            await matchDocumentsByContentHash(
                fake.db,
                [{ id: "d1", current_version_id: "v1", folder_id: null }],
                [hash("a")],
            ),
        ).toEqual({ ok: false, error });
    });
});

describe("matchDocumentsByContentHash paging", () => {
    it("keeps reading versions past the row cap, so copies elsewhere cannot hide a match", async () => {
        const elsewhere = Array.from({ length: 1000 }, (_, i) => ({
            id: `other-${i}`,
            filename: "Copy.pdf",
            content_sha256: hash("a"),
        }));
        const fake = scriptedDb([
            { table: "document_versions", data: elsewhere },
            {
                table: "document_versions",
                data: [{ id: "v1", filename: "Mine.pdf", content_sha256: hash("a") }],
            },
        ]);
        const result = await matchDocumentsByContentHash(
            fake.db,
            [{ id: "d1", current_version_id: "v1", folder_id: null }],
            [hash("a")],
        );
        expect(result).toEqual({
            ok: true,
            matches: { [hash("a")]: [{ id: "d1", filename: "Mine.pdf", folder_id: null }] },
        });
        expect(fake.calls[1].filters).toContainEqual(["range", 1000, 1999]);
        fake.done();
    });
});
