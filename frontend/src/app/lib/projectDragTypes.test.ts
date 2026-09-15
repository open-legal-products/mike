import { describe, expect, it } from "vitest";
import {
    isChatAttachmentDrag,
    isExternalFileDrag,
    isProjectItemDrag,
} from "./projectDragTypes";

describe("project drag types", () => {
    it.each([
        [[], false, false, false],
        [["text/plain"], false, false, false],
        [["Files"], true, true, false],
        [["application/mike-doc"], true, false, true],
        [["application/mike-folder"], false, false, true],
        [["application/mike-doc", "Files"], true, true, true],
    ])("recognizes %j", (types, attachment, files, projectItem) => {
        const transfer = { types: types as string[] };
        expect(isChatAttachmentDrag(transfer)).toBe(attachment);
        expect(isExternalFileDrag(transfer)).toBe(files);
        expect(isProjectItemDrag(transfer)).toBe(projectItem);
    });
});
