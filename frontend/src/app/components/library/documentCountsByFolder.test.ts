import { describe, expect, it } from "vitest";
import { documentCountsByFolder } from "./documentCountsByFolder";

describe("documentCountsByFolder", () => {
    it("counts direct documents per requested folder, zero for empty ones", () => {
        const documents = [{ folder_id: "a" }, { folder_id: null }, { folder_id: "a" }, { folder_id: "b" }, {}];
        expect(documentCountsByFolder(documents, ["a", "b", "empty"])).toEqual({ a: 2, b: 1, empty: 0 });
    });

    it.each([50, 100, 200])("reads each document's folder once for %i loaded folders", (n) => {
        let reads = 0;
        const folderIds = Array.from({ length: n }, (_, i) => `f${i}`);
        const documents = folderIds.flatMap((id) =>
            Array.from({ length: 5 }, () => ({ get folder_id() { reads++; return id; } })),
        );
        expect(Object.values(documentCountsByFolder(documents, folderIds))).toEqual(folderIds.map(() => 5));
        expect(reads).toBeLessThanOrEqual(documents.length);
    });
});
