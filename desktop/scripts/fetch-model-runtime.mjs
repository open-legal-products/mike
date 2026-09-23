// Build-time download only. The shipped app contains this runtime; users only
// opt into downloading model weights. No installer, Homebrew or Docker runs.
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import catalog from "../src/local/model-catalog.js";

const { RUNTIME } = catalog;
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Preserve Ollama's MIT notice alongside the third-party notices in the tarball.
const license = `MIT License

Copyright (c) 2023 Ollama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export async function verifyRuntimeArchive(archive) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(archive)) { bytes += chunk.length; hash.update(chunk); }
  if (bytes !== RUNTIME.sizeBytes || hash.digest("hex") !== RUNTIME.sha256)
    throw new Error("Ollama runtime archive failed its pinned size/SHA-256 check.");
}

async function verifyLinks(directory, root = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(item);
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Runtime archive contains an escaping symlink.");
    } else if (entry.isDirectory()) await verifyLinks(item, root);
  }
}

export async function fetchRuntime({ archivePath, destination = path.join(desktop, "local-stack", "bin", "ollama") } = {}) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(destination), ".ollama-stage-"));
  const payload = path.join(temporary, "payload");
  const backup = path.join(temporary, "previous");
  let movedPrevious = false;
  try {
    const archive = archivePath || path.join(temporary, "ollama-darwin.tgz");
    if (!archivePath) {
      const response = await fetch(RUNTIME.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!response.ok || !response.body) throw new Error("Could not download the pinned Ollama runtime.");
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(bytes > RUNTIME.sizeBytes ? new Error("Runtime download exceeded its pinned size.") : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(archive, { flags: "wx" }));
    }
    await verifyRuntimeArchive(archive);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim().split("\n");
    if (entries.some((entry) => path.isAbsolute(entry) || entry.split("/").includes("..")))
      throw new Error("Runtime archive has unsafe paths.");
    await mkdir(payload);
    execFileSync("tar", ["-xzf", archive, "-C", payload], { stdio: "inherit" });
    await verifyLinks(payload);
    await access(path.join(payload, "ollama"));
    await access(path.join(payload, "llama-server"));
    await writeFile(path.join(payload, "OLLAMA_LICENSE"), license);
    await writeFile(path.join(payload, "runtime.json"), JSON.stringify(RUNTIME, null, 2) + "\n");
    try { await rename(destination, backup); movedPrevious = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(payload, destination);
    console.log(`Pinned Ollama ${RUNTIME.version} is staged at ${destination}`);
  } catch (error) {
    if (movedPrevious) await rename(backup, destination).catch(() => {});
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--archive")) {
    console.error("Usage: node scripts/fetch-model-runtime.mjs [--archive /path/to/ollama-darwin.tgz]");
    process.exitCode = 1;
  } else {
    await fetchRuntime({ archivePath: args[1] }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
