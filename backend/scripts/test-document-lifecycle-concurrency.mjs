// Disposable local PostgreSQL only. Requires psql and an applied schema.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const url = new URL(process.env.SUPABASE_TEST_DB_URL ?? "postgres://invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error(
    "SUPABASE_TEST_DB_URL must name a disposable loopback database",
  );
}
const env = {
  ...process.env,
  PGCONNECT_TIMEOUT: "10",
  PGOPTIONS: "-c statement_timeout=30000 -c lock_timeout=10000",
  PGHOST: url.hostname.replace(/[\[\]]/g, ""),
  PGPORT: url.port || "5432",
  PGDATABASE: url.pathname.slice(1),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
};
function query(sql, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-XAtq", "-v", "ON_ERROR_STOP=1"], { env });
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      onOutput(out);
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(err || `psql exited ${code}`)),
    );
    child.stdin.end(sql);
  });
}
const doc = randomUUID(),
  ids = [randomUUID(), randomUUID(), randomUUID()];
const create = (id, first = false) =>
  `select public.create_document_version('${doc}', '${JSON.stringify({ id, source: "user_upload", storage_path: `test/${id}`, ...(first ? { version_number: 1 } : {}) })}'::jsonb);`;
try {
  await query(
    `insert into public.documents(id) values('${doc}'); ${create(ids[0], true)}`,
  );
  let locked;
  const lockReady = new Promise((resolve) => {
    locked = resolve;
  });
  const first = query(
    `begin;
select id from public.documents where id = '${doc}' for update;
\\echo LIFECYCLE_LOCKED
select pg_sleep(0.5);
${create(ids[1])}
commit;`,
    (output) => {
      if (output.includes("LIFECYCLE_LOCKED")) locked();
    },
  );
  await Promise.race([
    lockReady,
    first.then(() => {
      throw new Error("lock marker missing");
    }),
  ]);
  const second = query(create(ids[2]));
  await Promise.all([first, second]);
  const numbers = await query(
    `select array_agg(version_number order by version_number) from public.document_versions where document_id = '${doc}';`,
  );
  assert.equal(numbers, "{1,2,3}");
  assert.equal(
    await query(
      `select current_version_id from public.documents where id = '${doc}';`,
    ),
    ids[2],
  );

  await query(
    `select public.delete_document_version('${doc}', '${ids[0]}', null);`,
  );
  const outcomes = await Promise.all(
    ids
      .slice(1)
      .map((id) =>
        query(
          `select public.delete_document_version('${doc}', '${id}', null);`,
        ),
      ),
  );
  const results = outcomes.map((result) => JSON.parse(result));
  assert.equal(
    results.filter((result) => result.kind === "only_version").length,
    1,
  );
  assert.equal(results.filter((result) => result.deleted_version_id).length, 1);
  assert.equal(
    await query(
      `select count(*) from public.documents d join public.document_versions v on v.id = d.current_version_id where d.id = '${doc}' and v.deleted_at is null;`,
    ),
    "1",
  );
  console.log(
    "Concurrent version allocation and last-version deletion checks passed.",
  );
} finally {
  await query(`delete from public.documents where id = '${doc}';
delete from public.db_jobs where kind = 'document.cleanup' and payload->>'versionId' in (${ids.map((id) => `'${id}'`).join(",")});`);
}
