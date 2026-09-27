import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/access", async (original) => ({
    ...(await original<typeof import("../../../lib/access")>()),
    checkProjectAccess: access,
}));

import { findProjectDocumentDuplicates } from "../projects.service";

const hash = (c: string) => c.repeat(64);
const base = { projectId: "p1", userId: "u1", userEmail: "u1@example.test" };

describe("findProjectDocumentDuplicates", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        access.mockResolvedValue({ ok: true, projectRole: "editor" });
    });

    it("reports only current versions of this project's documents", async () => {
        const fake = scriptedDb([
            {
                table: "documents",
                data: [
                    { id: "d1", current_version_id: "v1", folder_id: "f1" },
                    { id: "d2", current_version_id: "v2", folder_id: null },
                ],
            },
            {
                table: "document_versions",
                data: [
                    { id: "v1", filename: "Lease.pdf", content_sha256: hash("a") },
                    // An older version of d2, and a document elsewhere.
                    { id: "v0", filename: "Old.pdf", content_sha256: hash("b") },
                    { id: "vx", filename: "Other.pdf", content_sha256: hash("a") },
                ],
            },
        ]);

        const result = await findProjectDocumentDuplicates(fake.db, {
            ...base,
            hashes: [hash("a"), hash("b"), hash("a")],
        });

        expect(result).toEqual({
            ok: true,
            data: {
                [hash("a")]: [{ id: "d1", filename: "Lease.pdf", folder_id: "f1" }],
            },
        });
        expect(access).toHaveBeenCalledWith("p1", "u1", "u1@example.test", fake.db);
        expect(fake.calls[0].filters).toEqual([["eq", "project_id", "p1"]]);
        expect(fake.calls[1].filters).toEqual([
            ["in", "content_sha256", [hash("a"), hash("b")]],
            ["is", "deleted_at", null],
        ]);
        fake.done();
    });

    it("hides the project from non-members", async () => {
        access.mockResolvedValue({ ok: false });
        const fake = scriptedDb([]);
        const result = await findProjectDocumentDuplicates(fake.db, {
            ...base,
            hashes: [hash("a")],
        });
        expect(result).toMatchObject({ ok: false, kind: "not_found" });
        fake.done();
    });

    it.each([
        ["not an array", "abc"],
        ["a malformed hash", ["xyz"]],
        ["an upper-case hash", ["A".repeat(64)]],
        ["too many hashes", Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, "0"))],
    ])("rejects %s", async (_label, hashes) => {
        const fake = scriptedDb([]);
        const result = await findProjectDocumentDuplicates(fake.db, { ...base, hashes });
        expect(result).toMatchObject({ ok: false, kind: "validation" });
        expect(access).not.toHaveBeenCalled();
        fake.done();
    });

    it("queries hashes in batches", async () => {
        const hashes = Array.from({ length: 30 }, (_, i) =>
            i.toString(16).padStart(64, "0"),
        );
        const fake = scriptedDb([
            { table: "documents", data: [{ id: "d1", current_version_id: "v1", folder_id: null }] },
            { table: "document_versions", data: [] },
            { table: "document_versions", data: [] },
        ]);
        const result = await findProjectDocumentDuplicates(fake.db, { ...base, hashes });
        expect(result).toEqual({ ok: true, data: {} });
        expect((fake.calls[1].filters[0][2] as string[]).length).toBe(25);
        expect((fake.calls[2].filters[0][2] as string[]).length).toBe(5);
        fake.done();
    });
});
