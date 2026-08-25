import { describe, expect, it, vi } from "vitest";
import {
    collectDroppedDocumentUploadEntries,
    dataTransferHasDirectory,
    DOCUMENT_UPLOAD_CONCURRENCY,
    documentUploadEntriesFromFiles,
    documentUploadFolderSegments,
    folderUploadProgressLabel,
    documentUploadPathSegments,
    documentUploadProgressEntries,
    MAX_DOCUMENTS_PER_DIRECTORY_UPLOAD,
    resolvedDocumentUploadProgressEntries,
    resolveDocumentUploadRootFolder,
    settleWithConcurrency,
} from "./documentDirectoryUpload";

function folderFile(name: string, relativePath: string) {
    const file = new File([name], name);
    Object.defineProperty(file, "webkitRelativePath", {
        value: relativePath,
    });
    return file;
}

describe("document directory upload paths", () => {
    it("reports live folder upload counts", () => {
        expect(
            folderUploadProgressLabel([
                "completed",
                "processing",
                "uploading",
                "pending",
            ]),
        ).toBe("2 of 4 uploaded");
    });
    it("returns immediately when there is no concurrent work", async () => {
        const worker = vi.fn(async (value: number) => value);

        await expect(settleWithConcurrency([], 0, worker)).resolves.toEqual([]);
        expect(worker).not.toHaveBeenCalled();
    });

    it("clamps non-positive concurrency to one worker", async () => {
        await expect(
            settleWithConcurrency([1, 2], 0, async (value) => value * 2),
        ).resolves.toEqual([
            { status: "fulfilled", value: 2 },
            { status: "fulfilled", value: 4 },
        ]);
    });

    it("keeps directory upload concurrency bounded and preserves result order", async () => {
        let active = 0;
        let maxActive = 0;
        let releaseFirstWave = () => {};
        const firstWave = new Promise<void>((resolve) => {
            releaseFirstWave = resolve;
        });

        const pending = settleWithConcurrency(
            [0, 1, 2, 3],
            DOCUMENT_UPLOAD_CONCURRENCY,
            async (value) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                if (value < DOCUMENT_UPLOAD_CONCURRENCY) await firstWave;
                active -= 1;
                if (value === 2) throw new Error("upload failed");
                return value * 2;
            },
        );

        await vi.waitFor(() =>
            expect(active).toBe(DOCUMENT_UPLOAD_CONCURRENCY),
        );
        expect(maxActive).toBe(DOCUMENT_UPLOAD_CONCURRENCY);
        releaseFirstWave();

        await expect(pending).resolves.toEqual([
            { status: "fulfilled", value: 0 },
            { status: "fulfilled", value: 2 },
            { status: "rejected", reason: expect.any(Error) },
            { status: "fulfilled", value: 6 },
        ]);
        expect(maxActive).toBe(DOCUMENT_UPLOAD_CONCURRENCY);
    });

    it("caps a directory upload at the backend hourly request limit", () => {
        expect(MAX_DOCUMENTS_PER_DIRECTORY_UPLOAD).toBe(50);
    });

    it("preserves the selected root folder and nested subfolders", () => {
        const file = folderFile(
            "agreement.pdf",
            "Matter/Contracts/Executed/agreement.pdf",
        );
        const [entry] = documentUploadEntriesFromFiles([file]);

        expect(entry.relativePath).toBe(
            "Matter/Contracts/Executed/agreement.pdf",
        );
        expect(documentUploadFolderSegments(entry)).toEqual([
            "Matter",
            "Contracts",
            "Executed",
        ]);
    });

    it("uploads ordinary files directly into the target folder", () => {
        const file = new File(["memo"], "memo.docx");
        const [entry] = documentUploadEntriesFromFiles([file]);

        expect(documentUploadPathSegments(entry)).toEqual(["memo.docx"]);
        expect(documentUploadFolderSegments(entry)).toEqual([]);
        expect(
            documentUploadPathSegments({ file, relativePath: "" }),
        ).toEqual(["memo.docx"]);
    });

    it("summarizes a selected directory as one top-level folder row", () => {
        const entries = documentUploadEntriesFromFiles([
            folderFile("agreement.pdf", "Matter/Contracts/agreement.pdf"),
            folderFile("memo.docx", "Matter/Advice/memo.docx"),
        ]);

        expect(documentUploadProgressEntries(entries)).toEqual([
            { kind: "folder", name: "Matter", sourceName: "Matter" },
        ]);
    });

    it("keeps direct files as file rows alongside dropped folders", () => {
        const entries = [
            ...documentUploadEntriesFromFiles([
                folderFile("agreement.pdf", "Matter/agreement.pdf"),
            ]),
            ...documentUploadEntriesFromFiles([
                new File(["memo"], "memo.docx"),
            ]),
        ];

        expect(documentUploadProgressEntries(entries)).toEqual([
            { kind: "folder", name: "Matter", sourceName: "Matter" },
            { kind: "file", name: "memo.docx", sourceName: "memo.docx" },
        ]);
        expect(
            documentUploadProgressEntries([
                { file: new File(["memo"], "memo.docx"), relativePath: "." },
            ]),
        ).toEqual([
            { kind: "file", name: "memo.docx", sourceName: "memo.docx" },
        ]);
    });

    it("does not show an unresolved folder as an uploading row", () => {
        const entries = documentUploadEntriesFromFiles([
            folderFile("agreement.pdf", "NDAs/agreement.pdf"),
            new File(["memo"], "memo.docx"),
        ]);

        expect(
            resolvedDocumentUploadProgressEntries(entries, new Map()),
        ).toEqual([
            { kind: "file", name: "memo.docx", sourceName: "memo.docx" },
        ]);
    });

    it("shows the backend-resolved folder name once uploading can begin", () => {
        const entries = documentUploadEntriesFromFiles([
            folderFile("agreement.pdf", "NDAs/agreement.pdf"),
        ]);

        expect(
            resolvedDocumentUploadProgressEntries(
                entries,
                new Map([["NDAs", "NDAs (2)"]]),
            ),
        ).toEqual([
            { kind: "folder", name: "NDAs (2)", sourceName: "NDAs" },
        ]);
    });

    it("normalizes separators and excludes traversal segments", () => {
        const file = new File(["memo"], "memo.docx");
        expect(
            documentUploadPathSegments({
                file,
                relativePath: "Matter\\.\\..\\Advice\\memo.docx",
            }),
        ).toEqual(["Matter", "Advice", "memo.docx"]);
    });

    it("recursively traverses dropped folders and all directory batches", async () => {
        const agreement = new File(["agreement"], "agreement.pdf");
        const advice = new File(["advice"], "advice.docx");
        const fileEntry = (file: File) => ({
            isFile: true,
            isDirectory: false,
            name: file.name,
            file: (resolve: (value: File) => void) => resolve(file),
        });
        const directoryEntry = (
            name: string,
            batches: unknown[][],
        ) => ({
            isFile: false,
            isDirectory: true,
            name,
            createReader: () => {
                let index = 0;
                return {
                    readEntries: (resolve: (entries: unknown[]) => void) =>
                        resolve(batches[index++] ?? []),
                };
            },
        });
        const nested = directoryEntry("Advice", [[fileEntry(advice)], []]);
        const root = directoryEntry("Matter", [
            [fileEntry(agreement)],
            [nested],
            [],
        ]);
        const dataTransfer = {
            items: [
                {
                    kind: "file",
                    webkitGetAsEntry: () => root,
                },
            ],
            files: [],
        } as unknown as DataTransfer;

        const entries = await collectDroppedDocumentUploadEntries(
            dataTransfer,
        );
        expect(entries.map((entry) => entry.relativePath)).toEqual([
            "Matter/agreement.pdf",
            "Matter/Advice/advice.docx",
        ]);
    });

    it("detects directory entries in a drag payload", () => {
        const directoryItem = {
            webkitGetAsEntry: () => ({ isDirectory: true }),
        };
        const fileItem = {
            webkitGetAsEntry: () => ({ isDirectory: false }),
        };

        expect(
            dataTransferHasDirectory({
                items: [fileItem, directoryItem],
            } as unknown as DataTransfer),
        ).toBe(true);
        expect(
            dataTransferHasDirectory({
                items: [{}, fileItem],
            } as unknown as DataTransfer),
        ).toBe(false);
    });

    it("falls back to the FileList when directory entry APIs are unavailable", async () => {
        const file = new File(["memo"], "memo.docx");
        const dataTransfer = {
            items: [
                { kind: "string" },
                { kind: "file", webkitGetAsEntry: () => null },
            ],
            files: [file],
        } as unknown as DataTransfer;

        await expect(
            collectDroppedDocumentUploadEntries(dataTransfer),
        ).resolves.toEqual([{ file, relativePath: "memo.docx" }]);
    });

    it("confirms before creating a suffixed folder", async () => {
        const resolveFolderPath = vi
            .fn()
            .mockResolvedValueOnce({
                conflict: true as const,
                folder_name: "NDAs",
                existing_folder_id: "old-folder",
                suggested_name: "NDAs (2)",
            })
            .mockResolvedValueOnce({
                conflict: false as const,
                folder_id: "new-folder",
                resolved_name: "NDAs (2)",
                folders: [],
            });
        const chooseConflict = vi.fn(async () => "rename" as const);

        const result = await resolveDocumentUploadRootFolder({
            rootFolderName: "NDAs",
            baseFolderId: null,
            resolveFolderPath,
            chooseConflict,
        });

        expect(chooseConflict).toHaveBeenCalledWith({
            conflict: true,
            folder_name: "NDAs",
            existing_folder_id: "old-folder",
            suggested_name: "NDAs (2)",
        });
        expect(resolveFolderPath).toHaveBeenLastCalledWith(
            ["NDAs"],
            null,
            "rename",
        );
        expect(result?.resolved_name).toBe("NDAs (2)");
    });

    it("returns a conflict-free root folder without prompting", async () => {
        const resolution = {
            conflict: false as const,
            folder_id: "folder-1",
            resolved_name: "NDAs",
            folders: [],
        };
        const chooseConflict = vi.fn();

        await expect(
            resolveDocumentUploadRootFolder({
                rootFolderName: "NDAs",
                baseFolderId: "parent-1",
                resolveFolderPath: vi.fn().mockResolvedValue(resolution),
                chooseConflict,
            }),
        ).resolves.toEqual(resolution);
        expect(chooseConflict).not.toHaveBeenCalled();
    });

    it("does not create a suffixed folder when the alert is dismissed", async () => {
        const resolveFolderPath = vi.fn().mockResolvedValue({
            conflict: true as const,
            folder_name: "NDAs",
            existing_folder_id: "old-folder",
            suggested_name: "NDAs (2)",
        });

        const result = await resolveDocumentUploadRootFolder({
            rootFolderName: "NDAs",
            baseFolderId: null,
            resolveFolderPath,
            chooseConflict: async () => "cancel",
        });

        expect(result).toBeNull();
        expect(resolveFolderPath).toHaveBeenCalledTimes(1);
    });
});
