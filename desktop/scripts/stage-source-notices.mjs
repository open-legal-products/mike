// Keep Mike's license and exact source identity beside its packaged servers.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [destination, nativeNotices] = process.argv.slice(2);
if (!destination || !nativeNotices) throw new Error("Usage: stage-source-notices.mjs APP_DIR NATIVE_NOTICES_DIR");
const manifest = JSON.parse(await fs.readFile(path.join(nativeNotices, "sources.json"), "utf8"));
if (manifest.formatVersion !== 1 || !Array.isArray(manifest.sources) || manifest.sources.length !== 5) {
  throw new Error("Native service notices are missing; run local:fetch first");
}
for (const source of manifest.sources) {
  if (typeof source.filename !== "string" || !/^[a-zA-Z0-9.-]+$/.test(source.filename)) throw new Error("Invalid native notice filename");
  const bytes = await fs.readFile(path.join(nativeNotices, source.filename));
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error(`Native notice failed verification: ${source.filename}`);
}
await fs.mkdir(destination, { recursive: true });
await fs.copyFile(path.join(repo, "LICENSE"), path.join(destination, "LICENSE"));
await fs.cp(nativeNotices, path.join(destination, "service-notices"), { recursive: true });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" }).trim().length > 0;
await fs.writeFile(path.join(destination, "SOURCE.json"), JSON.stringify({
  product: "Mike", license: "AGPL-3.0-only",
  repository: "https://github.com/Open-Legal-Products/mike",
  commit, source: `https://github.com/Open-Legal-Products/mike/tree/${commit}`,
  sourceArchive: `https://github.com/Open-Legal-Products/mike/archive/${commit}.tar.gz`,
  workingTreeModified: dirty, nativeServices: manifest.sources,
}, null, 2) + "\n");
console.log(`Staged Mike license, source identity and ${manifest.sources.length} service notices`);
