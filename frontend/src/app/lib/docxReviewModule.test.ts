import { describe, expect, it } from "vitest";
import {
    readOoxmlPart, serializeOoxmlPart, TreeDocumentStore, paragraphOrderOfPart,
    type OoxmlPart, type TreeDocOp,
} from "@docx-editor.dev/core/store";
import { docxReviewModule } from "./docxReviewModule";

const review = docxReviewModule.review!;
const namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const revision = { author: "Sample reviewer", date: "2026-09-25T00:00:00Z" };
function parse(xml: string, name = "/word/document.xml"): OoxmlPart {
    const result = readOoxmlPart(xml, { name, contentType: "application/xml" });
    if (!result.ok) throw new Error(result.reason);
    return result.part;
}
function story(body: string, name?: string) {
    return parse(`<w:document xmlns:w="${namespace}"><w:body>${body}</w:body></w:document>`, name);
}
function changes(part: OoxmlPart) {
    return review.collectReviewItems({ storyPart: part }).filter((item) => item.kind === "revision");
}
function apply(store: TreeDocumentStore, ...ops: TreeDocOp[]) {
    expect(store.transact((ctx) => { ops.forEach((op) => ctx.apply(op)); }).ok).toBe(true);
}

describe("Mike DOCX review module using the public core", () => {
    it.each(["acceptAllRevisions", "rejectAllRevisions"] as const)("round-trips a tracked replacement and %s with undo/redo", (op) => {
        const store = new TreeDocumentStore(story("<w:p><w:r><w:t>thirty days</w:t></w:r></w:p>"));
        const paragraphId = [...paragraphOrderOfPart(store.part).keys()][0];
        apply(store,
            { op: "deleteText", paragraphId, start: 0, end: 6, revision },
            { op: "insertText", paragraphId, offset: 6, text: "sixty", revision });
        const xml = serializeOoxmlPart(store.part);
        expect(xml).toContain("<w:del");
        expect(xml).toContain("<w:ins");
        const reopened = new TreeDocumentStore(parse(xml));
        const items = changes(reopened.part);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ revisionKind: "replace", text: "sixty", replacedText: "thirty", author: revision.author, date: revision.date, readOnly: false });
        expect(items[0].addresses).toHaveLength(2);
        expect(review.revisionItemsOfParagraph(reopened.part, [...paragraphOrderOfPart(reopened.part).keys()][0])).toEqual(items);
        apply(reopened, { op });
        expect(changes(reopened.part)).toHaveLength(0);
        const resolved = serializeOoxmlPart(reopened.part);
        expect(resolved).toContain(op === "acceptAllRevisions" ? "sixty" : "thirty");
        expect(resolved).not.toContain(op === "acceptAllRevisions" ? "thirty" : "sixty");
        expect(reopened.undo()).not.toBeNull();
        expect(changes(reopened.part)).toHaveLength(1);
        expect(reopened.redo()).not.toBeNull();
        expect(changes(reopened.part)).toHaveLength(0);
    });

    it("keeps revisions from other paragraphs and stories out of a local patch", () => {
        const insertion = (id: number, text: string) => `<w:ins w:id="${id}" w:author="Reviewer"><w:r><w:t>${text}</w:t></w:r></w:ins>`;
        const part = story(`<w:p>${insertion(1, "first")}</w:p><w:p>${insertion(2, "second")}</w:p>`);
        const header = story(`<w:p>${insertion(1, "header")}</w:p>`, "/word/header1.xml");
        const paragraphs = [...paragraphOrderOfPart(part).keys()];
        const items = review.collectReviewItems({ storyPart: part, furnitureParts: [header] });
        expect(items).toHaveLength(3);
        expect(review.revisionItemsOfParagraph(part, paragraphs[0]).map((item) => item.text)).toEqual(["first"]);
        expect(review.revisionItemsOfParagraph(part, "missing")).toEqual([]);
        const spanning = story(`<w:p>${insertion(1, "first")}</w:p><w:p>${insertion(1, "second")}</w:p>`);
        expect(review.revisionItemsOfParagraph(spanning, [...paragraphOrderOfPart(spanning).keys()][0])).toEqual([]);
    });

    it("retains comment cards and existing revisions without inventing provenance", () => {
        const part = story('<w:p><w:commentRangeStart w:id="1"/><w:ins w:id="8" w:author="Original reviewer"><w:r><w:t>Text</w:t></w:r></w:ins><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>');
        const commentsPart = parse(`<w:comments xmlns:w="${namespace}"><w:comment w:id="1" w:author="Comment author"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment></w:comments>`, "/word/comments.xml");
        const items = review.collectReviewItems({ storyPart: part, commentsPart });
        expect(items.map((item) => item.kind).sort()).toEqual(["comment", "revision"]);
        expect(items.find((item) => item.kind === "revision")).toMatchObject({ author: "Original reviewer", text: "Text" });
        expect(items.find((item) => item.kind === "revision")?.date).toBeUndefined();
        expect(items.find((item) => item.kind === "comment")).toMatchObject({ orphaned: false, comment: { author: "Comment author" } });
    });
});
