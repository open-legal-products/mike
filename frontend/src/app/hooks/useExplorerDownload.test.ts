import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadDocumentsZip, getDocumentUrl } from "@/app/lib/mikeApi";
import type { Document, Folder } from "@/app/components/shared/types";
import { useExplorerDownload } from "./useExplorerDownload";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getDocumentUrl: vi.fn(),
    downloadDocumentsZip: vi.fn(),
}));
const documentFile = { id: "doc-1", filename: "Old-name.docx" } as Document;
const folder = { id: "folder-1", name: "Drafts" } as Folder;
let downloads: Array<{ href: string; filename: string }>;

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    downloads = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
    ) {
        downloads.push({ href: this.href, filename: this.download });
    });
    vi.stubGlobal(
        "URL",
        class extends URL {
            static createObjectURL = vi.fn(() => "blob:archive");
            static revokeObjectURL = vi.fn();
        },
    );
});
afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("explorer downloads", () => {
    it("downloads the active document using the server's current filename", async () => {
        vi.mocked(getDocumentUrl).mockResolvedValue({
            url: "https://files.example/draft",
            filename: "Current-name.docx",
            version_id: "v2",
        });
        const { result } = renderHook(() => useExplorerDownload());
        await act(async () => {
            await result.current.downloadDocument(documentFile);
        });
        expect(getDocumentUrl).toHaveBeenCalledWith("doc-1");
        expect(downloads).toEqual([
            {
                href: "https://files.example/draft",
                filename: "Current-name.docx",
            },
        ]);
        expect(result.current.downloading).toBe(false);
    });

    it("downloads a folder archive and releases its blob URL", async () => {
        const archive = new Blob(["zip"], { type: "application/zip" });
        vi.mocked(downloadDocumentsZip).mockResolvedValue(archive);
        const { result } = renderHook(() => useExplorerDownload());
        await act(async () => {
            await result.current.downloadFolder(folder);
        });
        expect(downloadDocumentsZip).toHaveBeenCalledWith([], ["folder-1"]);
        expect(URL.createObjectURL).toHaveBeenCalledWith(archive);
        expect(downloads).toEqual([
            { href: "blob:archive", filename: "Drafts.zip" },
        ]);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(1000));
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:archive");
    });

    it("shows an intentional failure message and allows another attempt", async () => {
        vi.mocked(getDocumentUrl).mockRejectedValue(
            new Error("private backend exception"),
        );
        const { result } = renderHook(() => useExplorerDownload());
        await act(async () => {
            await result.current.downloadDocument(documentFile);
        });
        expect(result.current.error).toBe(
            "The file or folder could not be downloaded. Please try again.",
        );
        expect(result.current.downloading).toBe(false);
        expect(downloads).toEqual([]);
        act(() => {
            result.current.clearError();
        });
        expect(result.current.error).toBeNull();
        vi.mocked(getDocumentUrl).mockResolvedValue({
            url: "https://files.example/draft",
            filename: "Draft.docx",
            version_id: "v1",
        });
        await act(async () => {
            await result.current.downloadDocument(documentFile);
        });
        expect(downloads).toHaveLength(1);
    });

    it("prevents repeated clicks from starting overlapping requests", async () => {
        let finish!: (
            value: Awaited<ReturnType<typeof getDocumentUrl>>,
        ) => void;
        vi.mocked(getDocumentUrl).mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const { result } = renderHook(() => useExplorerDownload());
        let pending!: Promise<void>;
        act(() => {
            pending = result.current.downloadDocument(documentFile);
        });
        expect(result.current.downloading).toBe(true);
        await act(async () => {
            await result.current.downloadFolder(folder);
        });
        expect(downloadDocumentsZip).not.toHaveBeenCalled();
        await act(async () => {
            finish({
                url: "https://files.example/draft",
                filename: "Draft.docx",
                version_id: "v1",
            });
            await pending;
        });
        expect(result.current.downloading).toBe(false);
    });
});
