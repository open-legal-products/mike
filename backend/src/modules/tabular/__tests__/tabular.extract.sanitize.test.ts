// The DOCX→markdown path strips mammoth's HTML down to text. Two properties
// matter for the sanitization (both flagged by CodeQL on the single-pass
// version): tag-stripping must reach a fixed point so a reassembled tag like
// "<scr<script>ipt>" cannot survive, and entity decoding must handle "&amp;"
// last so already-escaped text is not double-unescaped into live markup.

import { describe, it, expect, vi } from "vitest";

let mammothHtml = "";
vi.mock("mammoth", () => ({
    default: {
        convertToHtml: async () => ({ value: mammothHtml }),
    },
    convertToHtml: async () => ({ value: mammothHtml }),
}));
vi.mock("../../../lib/convert", () => ({
    normalizeDocxZipPaths: async (buf: Buffer) => buf,
    docxToPdf: async (buf: Buffer) => buf,
}));

import { extractDocxMarkdown } from "../tabular.extract";

async function markdownFor(html: string): Promise<string> {
    mammothHtml = html;
    return extractDocxMarkdown(new ArrayBuffer(4));
}

describe("extractDocxMarkdown sanitization", () => {
    it("strips nested/reassembled tags to a fixed point", async () => {
        const out = await markdownFor("<p>safe <scr<script>ipt>alert(1)</script> text</p>");
        expect(out).not.toContain("<script");
        expect(out).not.toContain("<scr");
        expect(out).toContain("safe");
        expect(out).toContain("text");
    });

    it("does not double-unescape &amp;-escaped entities", async () => {
        // "&amp;lt;b&amp;gt;" is the ESCAPED text "&lt;b&gt;" — after one
        // correct decode it must read as literal "&lt;b&gt;", not "<b>".
        const out = await markdownFor("<p>&amp;lt;b&amp;gt;</p>");
        expect(out).toBe("&lt;b&gt;");
    });

    it("still decodes plain entities once", async () => {
        const out = await markdownFor("<p>a &lt;tag&gt; &amp; more&nbsp;here</p>");
        expect(out).toBe("a <tag> & more here");
    });
});
