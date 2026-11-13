import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// The filesystem driver's signed GET is the read half of
// /download/signed/:token. It is deliberately unauthenticated — the token is
// the authorization, minted after an access check. These cases pin the
// streaming contract: the object is piped to the client with a
// Content-Length, never buffered wholesale in the process heap, and a
// missing object still collapses to the same not_found answer as before.
let root: string;

async function loadApp() {
    vi.resetModules();
    process.env.STORAGE_DRIVER = "fs";
    process.env.STORAGE_FS_ROOT = root;
    process.env.DOWNLOAD_SIGNING_SECRET = "test-signing-secret";
    process.env.BACKEND_PUBLIC_URL = "http://localhost:3001";
    delete process.env.R2_ENDPOINT_URL;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;

    const storage = await import("../../lib/storage.js");
    const { downloadsRouter } = await import(
        "../../modules/downloads/downloads.routes.js"
    );

    const app = express();
    app.use("/download", downloadsRouter);
    app.use(express.json());
    return { app, storage };
}

async function signedPath(
    storage: { getSignedUrl: (key: string, expiresIn?: number, filename?: string) => Promise<string | null> },
    key: string,
): Promise<string> {
    const url = await storage.getSignedUrl(key, 60, "report.pdf");
    expect(url).toBeTruthy();
    return (url as string).replace("http://localhost:3001", "");
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mike-blob-get-"));
});

afterEach(async () => {
    delete process.env.STORAGE_DRIVER;
    delete process.env.STORAGE_FS_ROOT;
    delete process.env.BACKEND_PUBLIC_URL;
    await fs.rm(root, { recursive: true, force: true });
});

describe("GET /download/signed/:token (filesystem driver)", () => {
    it("streams the object with Content-Length and the attachment disposition", async () => {
        const { app, storage } = await loadApp();
        const key = "documents/u1/doc1/source.pdf";
        const body = Buffer.from("hello world");
        await storage.uploadFile(key, body, "application/pdf");
        const res = await request(app).get(await signedPath(storage, key));
        expect(res.status).toBe(200);
        expect(res.body).toEqual(body);
        expect(res.headers["content-length"]).toBe("11");
        expect(res.headers["content-type"]).toBe("application/pdf");
        expect(res.headers["content-disposition"]).toContain("attachment");
    });

    it("answers not_found for a token naming an object that does not exist", async () => {
        const { app, storage } = await loadApp();
        const res = await request(app).get(
            await signedPath(storage, "documents/u1/missing/source.pdf"),
        );
        expect(res.status).toBe(404);
    });

    it("answers not_found for an invalid token", async () => {
        const { app } = await loadApp();
        const res = await request(app).get("/download/signed/bogus-token");
        expect(res.status).toBe(404);
    });
});
