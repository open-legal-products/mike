import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { signDownload, verifyDownload, buildDownloadUrl } from "../downloadTokens";

const SECRET = "test-secret-32-bytes-long-enough!!";

beforeAll(() => {
    process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
});

afterAll(() => {
    delete process.env.DOWNLOAD_SIGNING_SECRET;
});

describe("signDownload", () => {
    it("returns a two-part dot-separated token", () => {
        const token = signDownload("documents/user/doc.pdf", "contract.pdf");
        const parts = token.split(".");
        expect(parts).toHaveLength(2);
        expect(parts[0].length).toBeGreaterThan(0);
        expect(parts[1].length).toBeGreaterThan(0);
    });

    it("produces different tokens for different paths", () => {
        const t1 = signDownload("documents/a/file.pdf", "a.pdf");
        const t2 = signDownload("documents/b/file.pdf", "b.pdf");
        expect(t1).not.toBe(t2);
    });

    it("uses base64url characters only (no +, /, =)", () => {
        const token = signDownload("documents/user/file.pdf", "file.pdf");
        expect(token).not.toMatch(/[+/=]/);
    });
});

describe("verifyDownload", () => {
    it("round-trips Unicode filenames and long runs of padding-like characters", () => {
        const path = `documents/user/${"=".repeat(20_000)}/source.docx`;
        const filename = "审阅 — café.docx";
        expect(verifyDownload(signDownload(path, filename))).toEqual({ path, filename });
    });

    it("round-trips a valid token", () => {
        const path = "documents/user123/doc456/source.pdf";
        const filename = "Contract Final v2.pdf";
        const token = signDownload(path, filename);
        const result = verifyDownload(token);
        expect(result).not.toBeNull();
        expect(result!.path).toBe(path);
        expect(result!.filename).toBe(filename);
    });

    it("returns null for a tampered payload", () => {
        const token = signDownload("documents/user/file.pdf", "file.pdf");
        const [, sig] = token.split(".");
        const fakePayload = Buffer.from(
            JSON.stringify({ p: "documents/attacker/file.pdf", f: "file.pdf" }),
        )
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
        expect(verifyDownload(`${fakePayload}.${sig}`)).toBeNull();
    });

    it("returns null for a tampered signature", () => {
        const token = signDownload("documents/user/file.pdf", "file.pdf");
        const [enc] = token.split(".");
        const fakeSig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        expect(verifyDownload(`${enc}.${fakeSig}`)).toBeNull();
    });

    it("returns null for a token with too many parts", () => {
        expect(verifyDownload("a.b.c")).toBeNull();
    });

    it("returns null for a token with too few parts", () => {
        expect(verifyDownload("onlyonepart")).toBeNull();
    });

    it("returns null when payload JSON is missing required fields", () => {
        const bad = Buffer.from(JSON.stringify({ x: 1 }))
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
        const sig = Buffer.alloc(32).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        expect(verifyDownload(`${bad}.${sig}`)).toBeNull();
    });

    it("returns null when signed with a different secret", () => {
        const token = signDownload("documents/user/file.pdf", "file.pdf");
        process.env.DOWNLOAD_SIGNING_SECRET = "different-secret-value-!!";
        const result = verifyDownload(token);
        process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
        expect(result).toBeNull();
    });
});

describe("buildDownloadUrl", () => {
    it("returns a path starting with /download/", () => {
        const url = buildDownloadUrl("documents/user/file.pdf", "file.pdf");
        expect(url).toMatch(/^\/download\//);
    });

    it("embeds a verifiable token in the URL", () => {
        const path = "documents/user/file.pdf";
        const filename = "file.pdf";
        const url = buildDownloadUrl(path, filename);
        const token = url.replace("/download/", "");
        const result = verifyDownload(token);
        expect(result).not.toBeNull();
        expect(result!.path).toBe(path);
        expect(result!.filename).toBe(filename);
    });
});
