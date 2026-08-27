import { describe, expect, it, vi } from "vitest";
import {
    collectionSelectAllState,
    folderSelectionRootIds,
    folderTreeIds,
    MULTI_DOCUMENT_DRAG_TYPE,
    readDocumentDragPayload,
    SINGLE_DOCUMENT_DRAG_TYPE,
    writeDocumentDragPayload,
} from "./docTableSelection";

describe("DocTable folder selection", () => {
    const folders = [
        { id: "parent", parent_folder_id: null },
        { id: "child", parent_folder_id: "parent" },
        { id: "grandchild", parent_folder_id: "child" },
        { id: "sibling", parent_folder_id: null },
    ];

    it("collects every descendant once", () => {
        expect([...folderTreeIds(folders, ["parent"])]).toEqual([
            "parent",
            "child",
            "grandchild",
        ]);
    });

    it("keeps only top-most selected folders", () => {
        expect(
            folderSelectionRootIds(
                folders,
                new Set(["parent", "child", "sibling"]),
            ),
        ).toEqual(["parent", "sibling"]);
    });

    it("stops safely when malformed folder ancestry contains a cycle", () => {
        const cyclicFolders = [
            { id: "a", parent_folder_id: "b" },
            { id: "b", parent_folder_id: "c" },
            { id: "c", parent_folder_id: "a" },
        ];

        expect(folderSelectionRootIds(cyclicFolders, new Set(["a"]))).toEqual([
            "a",
        ]);
    });
});

describe("DocTable select all state", () => {
    it("treats a folder-only view as fully selected", () => {
        expect(
            collectionSelectAllState(
                [],
                ["folder-a", "folder-b"],
                [],
                new Set(["folder-a", "folder-b"]),
            ),
        ).toEqual({ allSelected: true, someSelected: false });
    });

    it("treats a mixed file and folder selection as partial", () => {
        expect(
            collectionSelectAllState(
                ["document-a"],
                ["folder-a"],
                ["document-a"],
                new Set(),
            ),
        ).toEqual({ allSelected: false, someSelected: true });
    });
});

describe("DocTable document drag payload", () => {
    it("writes every selected row when dragging an existing selection", () => {
        const values = new Map<string, string>();
        const dataTransfer = {
            setData: vi.fn((type: string, value: string) =>
                values.set(type, value),
            ),
            getData: (type: string) => values.get(type) ?? "",
            effectAllowed: "none" as DataTransfer["effectAllowed"],
        };

        expect(
            writeDocumentDragPayload(dataTransfer, "b", ["a", "b", "c"]),
        ).toEqual(["a", "b", "c"]);
        expect(readDocumentDragPayload(dataTransfer)).toEqual([
            "a",
            "b",
            "c",
        ]);
        expect(values.has(SINGLE_DOCUMENT_DRAG_TYPE)).toBe(false);
        expect(values.has(MULTI_DOCUMENT_DRAG_TYPE)).toBe(true);
        expect(dataTransfer.effectAllowed).toBe("copyMove");
    });

    it("keeps the legacy single-row payload for version drops", () => {
        const values = new Map<string, string>();
        const dataTransfer = {
            setData: (type: string, value: string) => values.set(type, value),
            getData: (type: string) => values.get(type) ?? "",
            effectAllowed: "none" as DataTransfer["effectAllowed"],
        };

        writeDocumentDragPayload(dataTransfer, "b", ["a"]);

        expect(values.get(SINGLE_DOCUMENT_DRAG_TYPE)).toBe("b");
        expect(readDocumentDragPayload(dataTransfer)).toEqual(["b"]);
    });

    it("deduplicates and filters malformed multi-row payloads", () => {
        const dataTransfer = {
            getData: (type: string) =>
                type === MULTI_DOCUMENT_DRAG_TYPE
                    ? JSON.stringify(["a", "", "a", 7, "b"])
                    : "legacy",
        };

        expect(readDocumentDragPayload(dataTransfer)).toEqual(["a", "b"]);
    });

    it("falls back to the legacy payload when multi-row data is invalid", () => {
        expect(
            readDocumentDragPayload({
                getData: (type: string) =>
                    type === MULTI_DOCUMENT_DRAG_TYPE ? "{invalid" : "legacy",
            }),
        ).toEqual(["legacy"]);
        expect(
            readDocumentDragPayload({
                getData: (type: string) =>
                    type === MULTI_DOCUMENT_DRAG_TYPE
                        ? JSON.stringify({ id: "a" })
                        : "",
            }),
        ).toEqual([]);
    });
});
