import { describe, it, expect, vi } from "vitest";
import {
    resolveDoc,
    resolveDocLabel,
    createDocLabelResolver,
    type DocIndex,
    type DocStore,
} from "../types";

// ---------------------------------------------------------------------------
// resolveDoc
// ---------------------------------------------------------------------------

describe("resolveDoc", () => {
    const index: DocIndex = {
        "doc-1": { document_id: "uuid-aaa", filename: "contract.pdf" },
        "doc-2": { document_id: "uuid-bbb", filename: "nda.pdf" },
    };

    it("returns the doc entry for a known label", () => {
        expect(resolveDoc("doc-1", index)).toEqual({
            document_id: "uuid-aaa",
            filename: "contract.pdf",
        });
    });

    it("returns undefined for an unknown label", () => {
        expect(resolveDoc("doc-99", index)).toBeUndefined();
    });

    it("returns undefined for an empty string", () => {
        expect(resolveDoc("", index)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// resolveDocLabel
// ---------------------------------------------------------------------------

describe("resolveDocLabel", () => {
    const store: DocStore = new Map([
        ["doc-1", { storage_path: "path/a", file_type: "pdf", filename: "contract.pdf" }],
        ["doc-2", { storage_path: "path/b", file_type: "pdf", filename: "nda.pdf" }],
    ]);

    const index: DocIndex = {
        "doc-1": { document_id: "uuid-aaa", filename: "contract.pdf" },
        "doc-2": { document_id: "uuid-bbb", filename: "nda.pdf" },
    };

    it("resolves by label when the label is in the store", () => {
        expect(resolveDocLabel("doc-1", store, index)).toBe("doc-1");
    });

    it("resolves by filename when the filename matches a store entry", () => {
        expect(resolveDocLabel("contract.pdf", store, index)).toBe("doc-1");
    });

    it("resolves by document UUID via the docIndex", () => {
        expect(resolveDocLabel("uuid-bbb", store, index)).toBe("doc-2");
    });

    it("returns null when nothing matches", () => {
        expect(resolveDocLabel("unknown-id", store, index)).toBeNull();
    });

    it("returns null when docIndex is omitted and only UUID matches", () => {
        // Without the index there is no fallback for raw UUIDs.
        expect(resolveDocLabel("uuid-aaa", store)).toBeNull();
    });

    it("prioritises exact label match over filename match", () => {
        // If a label happens to equal a filename of a different doc,
        // the label match wins.
        const storeWithCrossMatch: DocStore = new Map([
            ["nda.pdf", { storage_path: "path/c", file_type: "pdf", filename: "contract.pdf" }],
        ]);
        // "nda.pdf" is a label here, and it IS in the store, so it should
        // be returned directly without the filename-fallback loop.
        expect(resolveDocLabel("nda.pdf", storeWithCrossMatch)).toBe("nda.pdf");
    });
});

describe("createDocLabelResolver", () => {
    it("indexes the store once for a batch and keeps first-match order", () => {
        const store: DocStore = new Map();
        const index: DocIndex = {};
        for (let i = 0; i < 500; i++) {
            store.set(`doc-${i}`, { storage_path: `p${i}`, file_type: "pdf", filename: i === 7 ? "dup.pdf" : `f${i}.pdf` });
            index[`doc-${i}`] = { document_id: `uuid-${i}`, filename: `f${i}.pdf` };
        }
        store.set("doc-500", { storage_path: "p", file_type: "pdf", filename: "dup.pdf" });
        const entries = vi.spyOn(Object, "entries");
        try {
            const labelFor = createDocLabelResolver(store, index);
            const ids = Array.from({ length: 100 }, (_, i) => `uuid-${499 - i}`);
            expect(ids.map(labelFor)).toEqual(ids.map((id) => id.replace("uuid", "doc")));
            expect(entries).toHaveBeenCalledTimes(1);
            expect(labelFor("dup.pdf")).toBe("doc-7");
            expect(labelFor("doc-3")).toBe("doc-3");
        } finally {
            entries.mockRestore();
        }
    });
});
