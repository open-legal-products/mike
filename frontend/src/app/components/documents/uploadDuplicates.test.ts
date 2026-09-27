import { describe, expect, it, vi } from "vitest";
import {
    describeUploadDuplicate,
    findUploadDuplicates,
} from "./uploadDuplicates";

const entry = (name: string) => ({ file: new File([name], name) });
// Content-addressed stand-in for SHA-256: the "hash" is the file's text.
const hashByContent = (content: Record<string, string>) =>
    vi.fn(async (file: File) => content[file.name] ?? null);

describe("findUploadDuplicates", () => {
    it("reports files already in the destination and repeats in the selection", async () => {
        const entries = [entry("a.pdf"), entry("b.pdf"), entry("b copy.pdf"), entry("c.pdf")];
        const hash = hashByContent({
            "a.pdf": "h-a",
            "b.pdf": "h-b",
            "b copy.pdf": "h-b",
            "c.pdf": "h-c",
        });
        const find = vi.fn(async () => ({
            "h-a": [{ id: "d1", filename: "Lease.pdf", folder_id: null }],
        }));

        const duplicates = await findUploadDuplicates(entries, find, hash);

        expect(find).toHaveBeenCalledWith(["h-a", "h-b", "h-c"]);
        expect(duplicates).toEqual([
            {
                entry: entries[0],
                kind: "existing",
                matches: [{ id: "d1", filename: "Lease.pdf", folder_id: null }],
            },
            { entry: entries[2], kind: "selection", sameAs: "b.pdf" },
        ]);
        expect(duplicates!.map(describeUploadDuplicate)).toEqual([
            "a.pdf: already here as Lease.pdf",
            "b copy.pdf: same file as b.pdf in this upload",
        ]);
    });

    it("returns no duplicates when nothing matches", async () => {
        const duplicates = await findUploadDuplicates(
            [entry("a.pdf")],
            async () => ({}),
            hashByContent({ "a.pdf": "h-a" }),
        );
        expect(duplicates).toEqual([]);
    });

    it("gives up (null) when a file cannot be hashed", async () => {
        const find = vi.fn();
        const duplicates = await findUploadDuplicates(
            [entry("a.pdf"), entry("b.pdf")],
            find,
            hashByContent({ "a.pdf": "h-a" }),
        );
        expect(duplicates).toBeNull();
        expect(find).not.toHaveBeenCalled();
    });

    it("gives up (null) when the check request fails", async () => {
        const duplicates = await findUploadDuplicates(
            [entry("a.pdf")],
            async () => {
                throw new Error("offline");
            },
            hashByContent({ "a.pdf": "h-a" }),
        );
        expect(duplicates).toBeNull();
    });

    it("summarises many existing matches", () => {
        expect(
            describeUploadDuplicate({
                entry: entry("x.pdf"),
                kind: "existing",
                matches: ["A.pdf", "B.pdf", "C.pdf", "D.pdf"].map((filename, i) => ({
                    id: `d${i}`,
                    filename,
                    folder_id: null,
                })),
            }),
        ).toBe("x.pdf: already here as A.pdf, B.pdf and 2 more");
    });
});
