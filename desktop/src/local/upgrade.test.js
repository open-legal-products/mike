// The desktop counterpart of .github/workflows/schema-drift.yml, run through
// the app's OWN migration runner instead of psql.
//
// Why this exists: main's drift job proves "baseline schema.sql + migrations
// added since == today's schema.sql" for deployments upgraded with psql. The
// Mac app upgrades a user's workspace with schema.js instead (pure-JS `pg`,
// no psql in the bundle), so that guarantee said nothing about it — and a
// migration psql applies happily (#505's CREATE INDEX CONCURRENTLY) took
// every existing installation down at boot while the packaged first-run e2e
// stayed green, because a fresh install never replays migrations at all.
//
// So: start the bundled Postgres in a temp dir, build the "existing
// installation" (baseline schema.sql out of git + the ledger an install of
// that vintage would carry), upgrade it with schema.applySchema, and demand
// the result fingerprints identically to a fresh install through the same
// code. Needs the fetched pg binaries (`npm run local:fetch`, or
// MIKE_LOCAL_FETCH_ONLY=postgres for just these) and git history reaching
// BASELINE_REF (CI checks out with fetch-depth: 0).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { Client } = require("pg");
const schema = require("./schema");
const { TRANSACTION_BLOCK_ERROR } = require("./sql");

// Same pin as schema-drift.yml, for the same reason: a commit where
// schema.sql and the migrations were in agreement. Advance both together.
const BASELINE_REF = "9a1277ba99cbd7dfae77e5b882e5cef8521fca2f";

const REPO = path.resolve(__dirname, "..", "..", "..");
const BACKEND = path.join(REPO, "backend");
const PG_BIN = path.join(__dirname, "..", "..", "local-stack", "bin", "pg", "bin");
const FINGERPRINT_SQL = path.join(BACKEND, "scripts", "schema-fingerprint.sql");

const pgAvailable = fs.existsSync(path.join(PG_BIN, "postgres"));
const gitHasBaseline =
  spawnSync("git", ["-C", REPO, "cat-file", "-e", `${BASELINE_REF}^{commit}`]).status === 0;
const required = process.env.MIKE_REQUIRE_LOCAL_STACK === "1";
if (required) {
  assert.ok(pgAvailable, `MIKE_REQUIRE_LOCAL_STACK=1 but no postgres at ${PG_BIN} — run local:fetch`);
  assert.ok(gitHasBaseline, `MIKE_REQUIRE_LOCAL_STACK=1 but git cannot see ${BASELINE_REF} — shallow clone?`);
}
const skip = !pgAvailable
  ? `bundled postgres not fetched (${PG_BIN})`
  : !gitHasBaseline
    ? `baseline ${BASELINE_REF} not in git history`
    : false;

const git = (...args) => {
  const res = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// A throwaway cluster from the same binaries the app bundles. Trust auth on
// loopback: this is a test database that lives for a few seconds.
async function startCluster() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mike-upgrade-test-"));
  const pgdata = path.join(dir, "pgdata");
  const res = spawnSync(path.join(PG_BIN, "initdb"),
    ["-D", pgdata, "-U", "postgres", "-E", "UTF8", "--auth=trust"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`initdb failed: ${res.stderr}`);
  const port = await freePort();
  const proc = spawn(path.join(PG_BIN, "postgres"),
    ["-D", pgdata, "-p", String(port), "-c", "listen_addresses=127.0.0.1", "-k", "", "-c", "fsync=off"],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d; });
  const withPg = async (fn) => {
    const client = new Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`postgres exited: ${stderr}`);
    try { await withPg((c) => c.query("select 1")); break; } catch { /* booting */ }
    if (Date.now() > deadline) throw new Error(`postgres never came up: ${stderr}`);
    await sleep(200);
  }
  const stop = async () => {
    proc.kill("SIGINT");
    await new Promise((r) => { proc.on("exit", r); setTimeout(r, 10_000); });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { withPg, stop };
}

// GoTrue owns `auth` and creates auth.users at boot; the product schema only
// references it (foreign keys, the signup/email triggers, and the password
// capability check). A stub carrying GoTrue's user columns stands in for
// GoTrue here — the shape of the users table is not under test.
async function resetDatabase(withPg) {
  await schema.pgExec(withPg, `
    drop schema if exists public cascade;
    create schema public;
    grant usage on schema public to anon, authenticated, service_role;
    drop schema if exists auth cascade;
    create schema auth;
    create table auth.users (
      instance_id uuid,
      id uuid primary key,
      aud varchar(255),
      role varchar(255),
      email varchar(255) unique,
      encrypted_password varchar(255),
      email_confirmed_at timestamptz,
      confirmed_at timestamptz,
      invited_at timestamptz,
      last_sign_in_at timestamptz,
      raw_app_meta_data jsonb,
      raw_user_meta_data jsonb,
      is_super_admin boolean,
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      phone text unique,
      deleted_at timestamptz,
      is_sso_user boolean not null default false,
      is_anonymous boolean not null default false
    );
    grant usage on schema auth to anon, authenticated, service_role;
  `, "reset");
}

// backend/scripts/schema-fingerprint.sql is written for `psql -XAtq`: the
// `\echo` section labels are the only psql-isms, so drop them and run the
// remaining selects as one batch; every query carries a total ORDER BY.
async function fingerprint(withPg) {
  const sql = fs.readFileSync(FINGERPRINT_SQL, "utf8")
    .split("\n").filter((line) => !line.startsWith("\\")).join("\n");
  const results = await withPg((c) => c.query(sql));
  return (Array.isArray(results) ? results : [results])
    .flatMap((r) => r.rows.map((row) => Object.values(row).join("|")))
    .join("\n");
}

const baselineSchema = () => git("show", `${BASELINE_REF}:backend/schema.sql`);
const baselineMigrations = () =>
  git("ls-tree", "--name-only", BASELINE_REF, "backend/migrations/")
    .split("\n").filter((f) => f.endsWith(".sql")).map((f) => path.basename(f)).sort();

// What an installation created at BASELINE_REF looks like on disk: that
// commit's schema.sql, and a ledger saying every migration shipped at that
// time is already contained in it (applySchema's own fresh-install rule).
async function buildBaselineInstallation(withPg) {
  await resetDatabase(withPg);
  await schema.pgExecFile(withPg, baselineSchema(), "baseline schema.sql");
  await schema.pgExec(withPg, `
    create table if not exists public.mike_schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
    insert into public.mike_schema_migrations (name)
      values ${baselineMigrations().map((m) => `('${m}')`).join(",")}
      on conflict do nothing;
  `, "baseline ledger");
}

test("an installation from the schema baseline upgrades through the app's runner to today's schema", { skip }, async () => {
  const cluster = await startCluster();
  try {
    const { withPg } = cluster;
    await schema.bootstrapRoles(withPg, "test-password");
    const current = schema.listMigrations(BACKEND);
    const pending = current.filter((m) => !baselineMigrations().includes(m));
    assert.ok(pending.length > 0, "the baseline must predate at least one migration");

    // 1. The trap, stated as a test: applied the naive way (one implicit
    //    transaction per file, which is what `pg` does with a multi-statement
    //    string), today's migration set is NOT applicable — as long as main
    //    carries a statement Postgres refuses inside a transaction block.
    const nonTransactional = pending.filter((m) =>
      /\b(create|drop)\s+index\s+concurrently\b|^\s*vacuum\b/im.test(
        fs.readFileSync(path.join(BACKEND, "migrations", m), "utf8")));
    if (nonTransactional.length > 0) {
      await buildBaselineInstallation(withPg);
      await assert.rejects(
        (async () => {
          for (const m of pending) {
            await withPg((c) => c.query(fs.readFileSync(path.join(BACKEND, "migrations", m), "utf8")));
          }
        })(),
        (err) => {
          assert.equal(err.code, TRANSACTION_BLOCK_ERROR,
            `expected SQLSTATE 25001 from ${nonTransactional.join(", ")} under a one-transaction-per-file runner, got ${err.code}: ${err.message}`);
          return true;
        },
      );
    }

    // 2. The real upgrade: same baseline installation, schema.applySchema.
    await buildBaselineInstallation(withPg);
    const statuses = [];
    await schema.applySchema(withPg, BACKEND, (s) => statuses.push(s));
    for (const m of pending) {
      assert.ok(statuses.includes(`Applying update ${m}…`), `runner must replay ${m}`);
    }
    const ledger = await withPg(async (c) =>
      (await c.query("select name from public.mike_schema_migrations order by name")).rows.map((r) => r.name));
    assert.deepEqual(ledger, current, "ledger must list every shipped migration after the upgrade");
    const upgraded = await fingerprint(withPg);

    // 3. Idempotence: a second boot on the upgraded workspace replays nothing.
    const again = [];
    await schema.applySchema(withPg, BACKEND, (s) => again.push(s));
    assert.deepEqual(again.filter((s) => s.startsWith("Applying")), []);

    // 4. Fresh install through the same runner must land on the same shape —
    //    the schema-drift guarantee, restated for the desktop code path.
    await resetDatabase(withPg);
    const freshStatuses = [];
    await schema.applySchema(withPg, BACKEND, (s) => freshStatuses.push(s));
    assert.deepEqual(freshStatuses, ["Setting up the product schema…"]);
    const fresh = await fingerprint(withPg);
    assert.ok(fresh.length > 1000, "fingerprint should describe a real schema");
    if (upgraded !== fresh) {
      const a = upgraded.split("\n"), b = fresh.split("\n");
      const onlyUpgraded = a.filter((l) => !b.includes(l));
      const onlyFresh = b.filter((l) => !a.includes(l));
      assert.fail(
        "upgraded installation and fresh install diverge through the desktop runner\n" +
        `only after upgrade (${onlyUpgraded.length}):\n  ${onlyUpgraded.slice(0, 20).join("\n  ")}\n` +
        `only on fresh install (${onlyFresh.length}):\n  ${onlyFresh.slice(0, 20).join("\n  ")}`);
    }
  } finally {
    await cluster.stop();
  }
});
