import { describe, expect, it } from "vitest";
import type { ReviewCommentPlacement } from "@docx-editor.dev/core/contracts/editor";
import { groupCommentThreads } from "./commentThreads";
const comment = (id: string, parentId: string | null = null) => ({ id, key: id, parentId } as ReviewCommentPlacement);
describe("comment thread grouping", () => {
    it("keeps orphan roots, nested reply order and active-thread identity", () => {
        const root = comment("root");
        const reply = comment("reply", "root");
        const nested = { ...comment("nested", "reply"), isActive: true };
        const orphan = comment("orphan", "missing");
        const grouped = groupCommentThreads([nested, orphan, root, reply]);
        expect(grouped.threads).toEqual([orphan, root]);
        expect(grouped.replies.get("root")).toEqual([nested, reply]);
        expect(grouped.activeThread).toBe("root");
    });
    it("terminates cycles and preserves each cycle member as a root", () => {
        const a = comment("a", "b"), b = comment("b", "a"), c = comment("c", "a");
        const grouped = groupCommentThreads([c, a, b]);
        expect(grouped.threads).toEqual([a, b]);
        expect(grouped.replies.get("a")).toEqual([c]);
    });
    it.each([100, 200, 400])("walks a reverse %i-deep chain only once", n => {
        let reads = 0;
        const items = Array.from({ length: n }, (_, i) => ({ ...comment(String(i)), get parentId() { reads++; return i ? String(i-1) : undefined; } })).reverse();
        const grouped = groupCommentThreads(items);
        expect(grouped.threads).toHaveLength(1);
        expect(grouped.replies.get("0")).toHaveLength(n-1);
        expect(reads).toBeLessThanOrEqual(2*n);
    });
});
