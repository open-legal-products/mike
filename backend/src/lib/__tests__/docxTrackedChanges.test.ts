import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
    applyTrackedEdits,
    extractDocxBodyText,
    extractTrackedChangeIds,
    resolveTrackedChange,
} from "../docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/**
 * Build a minimal in-memory .docx: a zip whose word/document.xml wraps the
 * given body XML. No [Content_Types].xml etc. — the module only reads
 * word/document.xml, so this is the smallest fixture that exercises it.
 */
async function makeDocx(bodyXml: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

function para(text: string): string {
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

async function readDocumentXml(bytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    return zip.file("word/document.xml")!.async("string");
}

describe("extractDocxBodyText", () => {
    it("joins paragraph texts with newlines", async () => {
        const bytes = await makeDocx(para("First paragraph.") + para("Second."));
        await expect(extractDocxBodyText(bytes)).resolves.toBe(
            "First paragraph.\nSecond.",
        );
    });

    it("preserves numeric-looking text through an unrelated edit", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:r><w:t>12.10</w:t></w:r>` +
                `<w:r><w:t> applies.</w:t></w:r>` +
                `</w:p>`,
        );
        const result = await applyTrackedEdits(bytes, [
            {
                find: "applies",
                replace: "governs",
                context_before: " ",
                context_after: ".",
            },
        ]);

        expect(result.errors).toEqual([]);
        expect(await readDocumentXml(result.bytes)).toContain("<w:t>12.10</w:t>");
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "12.10 governs.",
        );
        await expect(extractDocxBodyText(bytes)).resolves.toBe("12.10 applies.");
    });

    it("uses the accepted view: w:ins text included, w:del text excluded", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:r><w:t xml:space="preserve">Keep </w:t></w:r>` +
                `<w:ins w:id="1"><w:r><w:t>added</w:t></w:r></w:ins>` +
                `<w:del w:id="2"><w:r><w:delText>removed</w:delText></w:r></w:del>` +
                `</w:p>`,
        );
        await expect(extractDocxBodyText(bytes)).resolves.toBe("Keep added");
    });

    it("returns an empty string when word/document.xml is missing", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(extractDocxBodyText(bytes)).resolves.toBe("");
    });
});

describe("applyTrackedEdits", () => {
    it("emits a w:del/w:ins pair for a replacement and reports the change", async () => {
        const bytes = await makeDocx(para("The fee is ten dollars."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "ten dollars",
                replace: "five dollars",
                context_before: "The fee is ",
                context_after: ".",
            },
        ]);

        expect(result.errors).toEqual([]);
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change.deletedText).toBe("ten");
        expect(change.insertedText).toBe("five");
        expect(change.delId).toBeDefined();
        expect(change.insId).toBeDefined();

        const xml = await readDocumentXml(result.bytes);
        expect(xml).toContain("<w:del");
        expect(xml).toContain("<w:ins");
        expect(xml).toContain(`w:author="SambaNova"`);
        expect(xml).toContain("<w:delText");

        // Accepted view of the output shows the replacement applied.
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "The fee is five dollars.",
        );
    });

    it("trims common prefix/suffix so only the changed span is tracked", async () => {
        const bytes = await makeDocx(para("Payment due in 30 days."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "Payment due in 30 days",
                replace: "Payment due in 45 days",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].deletedText).toBe("30");
        expect(result.changes[0].insertedText).toBe("45");
    });

    it("honours a custom author", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(
            bytes,
            [{ find: "world", replace: "there", context_before: "", context_after: "" }],
            { author: "Reviewer" },
        );
        const xml = await readDocumentXml(result.bytes);
        expect(xml).toContain(`w:author="Reviewer"`);
    });

    it("supports a pure insertion anchored on context_before", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "",
                replace: "brave ",
                context_before: "Hello ",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBeUndefined();
        expect(result.changes[0].insId).toBeDefined();
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello brave world.",
        );
    });

    it("supports a pure deletion (empty replace)", async () => {
        const bytes = await makeDocx(para("Hello cruel world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "cruel ",
                replace: "",
                context_before: "Hello ",
                context_after: "world",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBeDefined();
        expect(result.changes[0].insId).toBeUndefined();
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello world.",
        );
    });

    it("numbers new tracked changes above the existing max w:id", async () => {
        const bytes = await makeDocx(
            `<w:p><w:ins w:id="7"><w:r><w:t>Existing insertion. </w:t></w:r></w:ins>` +
                `<w:r><w:t xml:space="preserve">Plain text.</w:t></w:r></w:p>`,
        );
        const result = await applyTrackedEdits(bytes, [
            {
                find: "Plain",
                replace: "Simple",
                context_before: "",
                context_after: " text.",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBe("8");
        expect(result.changes[0].insId).toBe("9");
    });

    it("reports an error for a find that is not in the document", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "goodbye",
                replace: "farewell",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: expect.stringContaining("Could not locate") },
        ]);
        // The document itself is returned intact.
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello world.",
        );
    });

    it("reports an ambiguous match instead of guessing", async () => {
        const bytes = await makeDocx(para("alpha beta alpha"));
        const result = await applyTrackedEdits(bytes, [
            { find: "alpha", replace: "gamma", context_before: "", context_after: "" },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: expect.stringContaining("Ambiguous match") },
        ]);
    });

    it("rejects empty edits and uncontexted pure insertions", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            { find: "", replace: "", context_before: "", context_after: "" },
            { find: "", replace: "orphan", context_before: "", context_after: "" },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: "Empty edit." },
            {
                index: 1,
                reason: "Pure insertion requires context_before or context_after.",
            },
        ]);
    });

    it("throws when word/document.xml is missing from the archive", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(applyTrackedEdits(bytes, [])).rejects.toThrow(
            "document.xml missing from docx",
        );
    });

    it("rejects bytes that are not a zip archive at all", async () => {
        await expect(
            applyTrackedEdits(Buffer.from("plainly not a zip"), []),
        ).rejects.toThrow();
    });
});

describe("resolveTrackedChange", () => {
    /** Apply one replace edit and return the output bytes + w:ids. */
    async function trackedFixture() {
        const bytes = await makeDocx(para("The fee is ten dollars."));
        const applied = await applyTrackedEdits(bytes, [
            {
                find: "ten",
                replace: "twenty",
                context_before: "The fee is ",
                context_after: " dollars",
            },
        ]);
        expect(applied.errors).toEqual([]);
        const { delId, insId } = applied.changes[0];
        return { bytes: applied.bytes, delId: delId!, insId: insId! };
    }

    it("accept collapses the change to the new text", async () => {
        const { bytes, delId, insId } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, [delId, insId], "accept");
        expect(resolved.found).toBe(true);
        await expect(extractDocxBodyText(resolved.bytes)).resolves.toBe(
            "The fee is twenty dollars.",
        );
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toEqual([]);
    });

    it("reject restores the original text, converting w:delText back to w:t", async () => {
        const { bytes, delId, insId } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, [delId, insId], "reject");
        expect(resolved.found).toBe(true);
        await expect(extractDocxBodyText(resolved.bytes)).resolves.toBe(
            "The fee is ten dollars.",
        );
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toEqual([]);
        const xml = await readDocumentXml(resolved.bytes);
        expect(xml).not.toContain("w:delText");
    });

    it("returns found=false and leaves the document alone for unknown ids", async () => {
        const { bytes } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, ["999"], "accept");
        expect(resolved.found).toBe(false);
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toHaveLength(2);
    });
});

describe("extractTrackedChangeIds", () => {
    it("lists w:ins/w:del wrappers in document order", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:ins w:id="3"><w:r><w:t>a</w:t></w:r></w:ins>` +
                `<w:del w:id="5"><w:r><w:delText>b</w:delText></w:r></w:del>` +
                `<w:ins w:id="9"><w:r><w:t>c</w:t></w:r></w:ins>` +
                `</w:p>`,
        );
        await expect(extractTrackedChangeIds(bytes)).resolves.toEqual([
            { kind: "ins", w_id: "3" },
            { kind: "del", w_id: "5" },
            { kind: "ins", w_id: "9" },
        ]);
    });

    it("returns [] when word/document.xml is missing", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(extractTrackedChangeIds(bytes)).resolves.toEqual([]);
    });
});
