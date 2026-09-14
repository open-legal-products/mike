import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// The filesystem driver's signed PUT is the write half of
// /download/signed/:token. It is deliberately unauthenticated — the browser
// sends it straight from the upload-session flow with no Authorization header,
// exactly as it would to an S3 presigned URL — so the token itself has to
// carry every constraint. These cases pin that contract.
//
// STORAGE_DRIVER / STORAGE_FS_ROOT are read at module load in ../../lib/storage,
// so each case configures process.env before importing a fresh copy (the same
// reset-then-dynamic-import pattern as the storageFs unit tests).
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

  const storage = await import("../../lib/storage");
  const tokens = await import("../../lib/downloadTokens");
  const { blobUploadHandler } = await import("../downloads");

  const app = express();
  // Mirrors app.ts on both counts: the PUT sits in its own rate-limit lane, and
  // it is registered ahead of the JSON body parser so the body reaches the
  // handler unconsumed and is streamed to disk. The limiter's ceiling is high
  // enough never to fire here; it is present so the test exercises the same
  // middleware stack the real route has.
  app.put(
    "/download/signed/:token",
    rateLimit({ windowMs: 60_000, max: 10_000, validate: false }),
    blobUploadHandler,
  );
  app.use(express.json());
  return { app, storage, tokens };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mike-blob-put-"));
});

afterEach(async () => {
  delete process.env.STORAGE_DRIVER;
  delete process.env.STORAGE_FS_ROOT;
  delete process.env.BACKEND_PUBLIC_URL;
  await fs.rm(root, { recursive: true, force: true });
});

describe("PUT /download/signed/:token (filesystem driver)", () => {
  it("stores a body that matches the signed type and size", async () => {
    const { app, storage, tokens } = await loadApp();
    const body = Buffer.from("%PDF-1.7 hello");
    const token = tokens.signBlobUploadToken(
      "uploads/s1/f1.pdf",
      "application/pdf",
      body.length,
      900,
    );

    const response = await request(app)
      .put(`/download/signed/${token}`)
      .set("Content-Type", "application/pdf")
      .send(body);

    expect(response.status).toBe(200);
    const stored = await storage.downloadFile("uploads/s1/f1.pdf");
    expect(Buffer.from(stored!).equals(body)).toBe(true);
  });

  it("rejects a forged or expired token without writing anything", async () => {
    const { app, storage, tokens } = await loadApp();
    const expired = tokens.signBlobUploadToken(
      "uploads/s1/f1.pdf",
      "application/pdf",
      3,
      -5,
    );

    expect(
      (await request(app).put("/download/signed/not.atoken").send("abc")).status,
    ).toBe(403);
    expect(
      (await request(app).put(`/download/signed/${expired}`).send("abc")).status,
    ).toBe(403);
    expect(await storage.downloadFile("uploads/s1/f1.pdf")).toBeNull();
  });

  it("refuses a read token spent as a write token", async () => {
    const { app, tokens } = await loadApp();
    // Same route, domain-separated HMACs: holding a download capability must
    // not let the holder overwrite the object it can read.
    const readToken = tokens.signBlobToken(
      "uploads/s1/f1.pdf",
      "f1.pdf",
      900,
    );
    const response = await request(app)
      .put(`/download/signed/${readToken}`)
      .send("overwritten");
    expect(response.status).toBe(403);
  });

  it("discards a body whose size differs from the signed size", async () => {
    const { app, storage, tokens } = await loadApp();
    // The S3 URL this replaces binds Content-Length into the signature, so a
    // wrong-size body fails at the store. Match that, and leave no partial
    // file behind for the upload session to mistake for a finished one.
    const token = tokens.signBlobUploadToken(
      "uploads/s1/f1.pdf",
      "application/pdf",
      3,
      900,
    );

    const response = await request(app)
      .put(`/download/signed/${token}`)
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("far too many bytes"));

    expect(response.status).toBe(400);
    expect(await storage.downloadFile("uploads/s1/f1.pdf")).toBeNull();
  });

  it("refuses a body whose content type differs from the signed type", async () => {
    const { app, storage, tokens } = await loadApp();
    const token = tokens.signBlobUploadToken(
      "uploads/s1/f1.pdf",
      "application/pdf",
      3,
      900,
    );

    const response = await request(app)
      .put(`/download/signed/${token}`)
      .set("Content-Type", "text/html")
      .send(Buffer.from("abc"));

    expect(response.status).toBe(400);
    expect(await storage.downloadFile("uploads/s1/f1.pdf")).toBeNull();
  });

  it("streams a JSON body to disk instead of letting a parser eat it", async () => {
    const { app, storage, tokens } = await loadApp();
    // The regression this guards: registering the PUT after express.json()
    // would leave the request stream drained and the file empty.
    const body = Buffer.from('{"claim":"this is a file, not a request"}');
    const token = tokens.signBlobUploadToken(
      "uploads/s1/f1.json",
      "application/json",
      body.length,
      900,
    );

    const response = await request(app)
      .put(`/download/signed/${token}`)
      // .send(string) with a JSON content type transmits the bytes verbatim;
      // .send(object) would re-serialize and change the length.
      .set("Content-Type", "application/json")
      .send(body.toString());

    expect(response.status).toBe(200);
    const stored = await storage.downloadFile("uploads/s1/f1.json");
    expect(Buffer.from(stored!).toString()).toBe(body.toString());
  });
});
