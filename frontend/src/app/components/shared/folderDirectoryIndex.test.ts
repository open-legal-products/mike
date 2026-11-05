import { describe, expect, it } from "vitest";
import { indexFolderDirectory } from "./folderDirectoryIndex";
describe("directory aggregation", () => {
    it.each([100, 200, 400])("indexes %i deep folders with linear source reads", n => {
        let reads = 0;
        const folders = Array.from({length:n}, (_, i) => ({id:String(i), get parent_folder_id() { reads++; return i ? String(i-1) : null; }})).reverse();
        const documents = Array.from({length:n}, (_, i) => ({id:`doc${i}`, folder:String(i)}));
        const index = indexFolderDirectory(folders, documents, d => d.folder, new Set(["doc0", `doc${n-1}`]), id => id !== String(n-1));
        expect(reads).toBe(n);
        expect(index.summaries.get("0")).toEqual({count:n, selected:2, fullyLoaded:false});
        expect(index.summaries.get(String(n-1))?.count).toBe(1);
        expect(index.collect("0")).toEqual(documents);
    });
    it("keeps sibling order and isolates root and orphan documents", () => {
        const folders = [{id:"r",parent_folder_id:null},{id:"b",parent_folder_id:"r"},{id:"a",parent_folder_id:"r"}];
        const docs = [{id:"root",folder:null},{id:"r",folder:"r"},{id:"a",folder:"a"},{id:"b",folder:"b"},{id:"orphan",folder:"missing"}];
        const index = indexFolderDirectory(folders, docs, d => d.folder);
        expect(index.collect("r").map(d => d.id)).toEqual(["r","b","a"]);
        expect(index.summaries.get("r")?.count).toBe(3);
        expect(index.direct.get(null)?.[0].id).toBe("root");
    });
    it("terminates corrupt cycles and keeps their selection disabled", () => {
        const index = indexFolderDirectory([{id:"a",parent_folder_id:"b"},{id:"b",parent_folder_id:"a"}], [{id:"doc",folder:"a"}], d => d.folder);
        expect(index.collect("a")).toHaveLength(1);
        expect(index.summaries.get("a")?.fullyLoaded).toBe(false);
    });
});
