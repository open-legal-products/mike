import { describe, expect, it, vi } from "vitest";
import {
    collectionRowKeysInVisualOrder,
    collectionSelectAllState,
    folderAncestorIds,
    folderSelectionRootIds,
    folderTreeIds,
    MULTI_DOCUMENT_DRAG_TYPE,
    readDocumentDragPayload,
    SINGLE_DOCUMENT_DRAG_TYPE,
    writeDocumentDragPayload,
} from "./docTableSelection";
import { indexById } from "./idCollections";

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

    it("handles branching trees, duplicate roots, and empty root ids", () => {
        const branchingFolders = [
            { id: "root", parent_folder_id: null },
            { id: "left", parent_folder_id: "root" },
            { id: "right", parent_folder_id: "root" },
        ];

        expect(
            folderTreeIds(branchingFolders, ["root", "root", ""]),
        ).toEqual(new Set(["root", "left", "right"]));
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

    it("keeps selections with unknown or dangling ancestry", () => {
        expect(
            folderSelectionRootIds(
                [{ id: "child", parent_folder_id: "missing" }],
                new Set(["child", "unknown"]),
            ),
        ).toEqual(["child", "unknown"]);
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

    it("reports no selection when the view is empty", () => {
        expect(collectionSelectAllState([], [], [], new Set())).toEqual({
            allSelected: false,
            someSelected: false,
        });
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

    it("reads a drag that carries only the legacy single-row payload", () => {
        // A drag started by an older tab (or any non-DocTable source) sets no
        // multi-row type at all, so getData returns "" and the JSON.parse must
        // be skipped rather than attempted on an empty string.
        expect(
            readDocumentDragPayload({
                getData: (type: string) =>
                    type === SINGLE_DOCUMENT_DRAG_TYPE ? "legacy" : "",
            }),
        ).toEqual(["legacy"]);
    });
});

describe("collectionRowKeysInVisualOrder", () => {
    function rowsAt(tops: number[]) {
        const measured = { count: 0 };
        const table = document.createElement("div");
        const rows = tops.map((top, index) => {
            const row = table.appendChild(document.createElement("div"));
            row.dataset.collectionRowKey = `document:${index}`;
            row.getBoundingClientRect = () => {
                measured.count++;
                return { top } as DOMRect;
            };
            return row;
        });
        return { rows, measured };
    }

    it("orders by on-screen top, keeping document order on ties", () => {
        const { rows } = rowsAt([30, 10, 30, 0]);
        expect(collectionRowKeysInVisualOrder(rows)).toEqual([
            "document:3", "document:1", "document:0", "document:2",
        ]);
    });

    it.each([100, 400])("measures each of %i rows once", (n) => {
        const { rows, measured } = rowsAt(
            Array.from({ length: n }, (_, i) => (i * 7919) % n),
        );
        expect(collectionRowKeysInVisualOrder(rows)).toHaveLength(n);
        expect(measured.count).toBe(n);
    });
});

describe("folderAncestorIds", () => {
    it("collects each start folder and its ancestors, ignoring roots and cycles", () => {
        const folders = indexById([
            { id: "root", parent_folder_id: null },
            { id: "mid", parent_folder_id: "root" },
            { id: "leaf", parent_folder_id: "mid" },
            { id: "a", parent_folder_id: "b" },
            { id: "b", parent_folder_id: "a" },
        ]);
        expect([...folderAncestorIds(["leaf", null, undefined], folders)]).toEqual(["leaf", "mid", "root"]);
        expect([...folderAncestorIds(["a"], folders)]).toEqual(["a", "b"]);
    });

    it.each([100, 400])("walks a %i-deep chain for every document in it with linear id reads", (n) => {
        let reads = 0;
        const folders = Array.from({ length: n }, (_, i) => ({
            get id() { reads++; return `f${i}`; },
            parent_folder_id: i ? `f${i - 1}` : null,
        }));
        // One selected document in every folder, deepest first.
        const startIds = folders.map((_, i) => `f${n - 1 - i}`);
        expect(folderAncestorIds(startIds, indexById(folders)).size).toBe(n);
        expect(reads).toBeLessThanOrEqual(n);
    });
});
