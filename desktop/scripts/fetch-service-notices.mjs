// Called independently of the native binary cache; does not build or run them.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function serviceNotices(pgPackage, postgrest, gotrue) {
  const pg = /^(\d+)\.(\d+)\.(\d+)(?:-[a-zA-Z0-9.-]+)?$/.exec(pgPackage);
  if (!pg || !/^v[\d.]+$/.test(postgrest) || !/^v[\d.]+$/.test(gotrue)) {
    throw new Error("Service notice versions must match the pinned release tags");
  }
  const postgres = `${pg[1]}.${pg[2]}`;
  const zonky = `${pg[1]}.${pg[2]}.${pg[3]}`;
  const entries = [
    ["postgresql-COPYRIGHT", "PostgreSQL", postgres, "postgres/postgres", `REL_${pg[1]}_${pg[2]}`, "COPYRIGHT"],
    ["embedded-postgres-LICENSE.md", "embedded-postgres npm package", pgPackage, "leinelissen/embedded-postgres", `v${pgPackage}`, "LICENSE.md"],
    ["zonky-LICENSE", "embedded-postgres-binaries distributor", zonky, "zonkyio/embedded-postgres-binaries", `v${zonky}`, "LICENSE"],
    ["postgrest-LICENSE", "PostgREST", postgrest, "PostgREST/postgrest", postgrest, "LICENSE"],
    ["gotrue-LICENSE", "Supabase Auth / GoTrue", gotrue, "supabase/auth", gotrue, "LICENSE"],
  ];
  return entries.map(([filename, component, version, repository, ref, sourceFile]) => ({
    filename, component, version,
    source: `https://github.com/${repository}/tree/${ref}`,
    sourceArchive: `https://github.com/${repository}/archive/refs/tags/${ref}.tar.gz`,
    notice: `https://raw.githubusercontent.com/${repository}/${ref}/${sourceFile}`,
  }));
}

export async function fetchServiceNotices(destination, versions, fetchImpl = fetch) {
  const entries = serviceNotices(...versions);
  await fs.mkdir(destination, { recursive: true });
  const sources = [];
  for (const entry of entries) {
    const response = await fetchImpl(entry.notice, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Could not fetch ${entry.component} notice (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 100 || bytes.length > 256 * 1024 || bytes.toString("utf8").includes("<html")) {
      throw new Error(`Invalid upstream notice for ${entry.component}`);
    }
    const tmp = path.join(destination, `${entry.filename}.tmp`);
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, path.join(destination, entry.filename));
    sources.push({ ...entry, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await fs.writeFile(path.join(destination, "sources.json"), JSON.stringify({ formatVersion: 1, sources }, null, 2) + "\n");
  return sources;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, ...versions] = process.argv.slice(2);
  if (!destination || versions.length !== 3) throw new Error("Usage: fetch-service-notices.mjs DEST PG_PACKAGE POSTGREST GOTRUE");
  const sources = await fetchServiceNotices(destination, versions);
  console.log(`Fetched ${sources.length} pinned service notices into ${destination}`);
}
