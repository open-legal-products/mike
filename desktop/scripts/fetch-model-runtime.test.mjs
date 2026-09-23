import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyRuntimeArchive } from "./fetch-model-runtime.mjs";

test("refuses a changed or truncated native runtime archive before extraction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mike-runtime-test-"));
  try {
    const archive = path.join(directory, "runtime.tgz");
    await writeFile(archive, "untrusted executable");
    await assert.rejects(verifyRuntimeArchive(archive), /SHA-256/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
