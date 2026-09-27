import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUploadDuplicateCheck, type UploadDuplicateDecision } from "./useUploadDuplicateCheck";

const api = vi.hoisted(() => ({
    findProjectDocumentDuplicates: vi.fn(),
    findLibraryDocumentDuplicates: vi.fn(),
    getDocument: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", () => api);
// Content-addressed stand-in for SHA-256: the "hash" is the file's text.
vi.mock("@/app/lib/fileHash", () => ({
    sha256Hex: async (file: File) => `hash:${await file.text()}`,
}));

type Entry = { file: File };
type Hook = ReturnType<typeof useUploadDuplicateCheck>;

let hook: Hook;
function Harness({ capture }: { capture: (value: Hook) => void }) {
    const value = useUploadDuplicateCheck();
    useEffect(() => capture(value));
    return <>{value.duplicateDialog}</>;
}

const file = (name: string, content = name) => new File([content], name);

async function run(
    start: () => Promise<UploadDuplicateDecision<Entry> | null>,
    button?: string,
) {
    let pending!: Promise<UploadDuplicateDecision<Entry> | null>;
    act(() => {
        pending = start();
    });
    if (button) {
        fireEvent.click(await screen.findByRole("button", { name: button }));
    }
    let result: UploadDuplicateDecision<Entry> | null | undefined;
    await act(async () => {
        result = await pending;
    });
    return result;
}

beforeEach(() => {
    vi.clearAllMocks();
    api.findProjectDocumentDuplicates.mockResolvedValue({
        "hash:lease": [{ id: "d1", filename: "Lease.pdf", folder_id: null }],
    });
    api.getDocument.mockResolvedValue({ id: "d1", filename: "Lease.pdf" });
    render(
        <Harness
            capture={(value) => {
                hook = value;
            }}
        />,
    );
});

describe("useUploadDuplicateCheck", () => {
    it("uses the existing document instead of uploading a copy", async () => {
        const entries = [{ file: file("Lease.pdf", "lease") }, { file: file("Other.pdf") }];
        const result = await run(
            () => hook.checkProjectUpload("p1", entries, { reuse: true }),
            "Use existing",
        );
        expect(api.findProjectDocumentDuplicates).toHaveBeenCalledWith("p1", [
            "hash:lease",
            "hash:Other.pdf",
        ]);
        expect(result?.upload.map((entry) => entry.file.name)).toEqual(["Other.pdf"]);
        expect(result?.reuse).toEqual([{ id: "d1", filename: "Lease.pdf" }]);
    });

    it("skips duplicates without reuse", async () => {
        const entries = [{ file: file("Lease.pdf", "lease") }, { file: file("Other.pdf") }];
        const result = await run(
            () => hook.checkProjectUpload("p1", entries),
            "Skip duplicates",
        );
        expect(result?.upload.map((entry) => entry.file.name)).toEqual(["Other.pdf"]);
        expect(result?.reuse).toEqual([]);
        expect(api.getDocument).not.toHaveBeenCalled();
    });

    it("uploads everything on 'Upload anyway' and nothing on Cancel", async () => {
        const entries = [{ file: file("Lease.pdf", "lease") }];
        const all = await run(
            () => hook.checkProjectUpload("p1", entries, { reuse: true }),
            "Upload anyway",
        );
        expect(all).toEqual({ upload: entries, reuse: [] });
        const cancelled = await run(
            () => hook.checkProjectUpload("p1", entries, { reuse: true }),
            "Cancel",
        );
        expect(cancelled).toBeNull();
    });

    it("does not ask when nothing is a duplicate", async () => {
        api.findProjectDocumentDuplicates.mockResolvedValue({});
        const entries = [{ file: file("Other.pdf") }];
        const result = await run(() => hook.checkProjectUpload("p1", entries));
        expect(result).toEqual({ upload: entries, reuse: [] });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("checks standalone uploads against the user's library", async () => {
        api.findLibraryDocumentDuplicates.mockResolvedValue({
            "hash:lease": [{ id: "d1", filename: "Lease.pdf", folder_id: null }],
        });
        const entries = [{ file: file("Lease.pdf", "lease") }];
        const result = await run(
            () => hook.checkLibraryUpload("files", entries, { reuse: true }),
            "Use existing",
        );
        expect(api.findLibraryDocumentDuplicates).toHaveBeenCalledWith("files", [
            "hash:lease",
        ]);
        expect(api.findProjectDocumentDuplicates).not.toHaveBeenCalled();
        expect(result).toEqual({
            upload: [],
            reuse: [{ id: "d1", filename: "Lease.pdf" }],
        });
    });

    it("checks only the selection when there is no project yet", async () => {
        const entries = [
            { file: file("a.pdf", "same") },
            { file: file("b.pdf", "same") },
        ];
        const result = await run(() => hook.checkSelection(entries), "Skip duplicates");
        expect(api.findProjectDocumentDuplicates).not.toHaveBeenCalled();
        expect(result?.upload.map((entry) => entry.file.name)).toEqual(["a.pdf"]);
    });
});
