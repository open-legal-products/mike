// Product schema bootstrap for the local stack — db-init's job, plus the
// upgrade story a downloaded app needs and docker-compose never did.
//
// This module deliberately knows nothing about ports, secrets or processes:
// every function takes `withPg`, a `(fn) => Promise` that hands `fn` a
// connected `pg` Client. The supervisor binds it to the running local
// Postgres; upgrade.test.js binds it to a throwaway cluster started from
// the same bundled binaries, so the exact code that migrates a user's
// workspace is what CI exercises against an old schema baseline.

const fs = require("fs");
const path = require("path");
const { runSqlFile } = require("./sql");

async function pgValue(withPg, sql) {
  return withPg(async (client) => {
    const res = await client.query(sql);
    const row = res.rows?.[0];
    return row ? String(Object.values(row)[0]) : "";
  });
}

async function pgExec(withPg, sql, label) {
  try {
    await withPg((client) => client.query(sql));
  } catch (err) {
    throw new Error(`${label ?? "sql"} failed: ${String(err.message).slice(0, 2000)}`);
  }
}

// schema.sql and migration files: the `pg` simple protocol runs a
// multi-statement string as ONE implicit transaction, which is the
// all-or-nothing a migration runner wants — except main's migrations are
// written for psql and may carry statements Postgres refuses inside a
// transaction block (#505 added `DROP/CREATE INDEX CONCURRENTLY`).
// runSqlFile (./sql.js) retries such a file statement by statement.
async function pgExecFile(withPg, sql, label) {
  try {
    await withPg((client) => runSqlFile((text) => client.query(text), sql));
  } catch (err) {
    throw new Error(`${label ?? "sql"} failed: ${String(err.message).slice(0, 2000)}`);
  }
}

// Everything the supabase/postgres image pre-creates that this stack relies
// on, distilled: the role ladder (authenticator can wear anon/authenticated/
// service_role; service_role BYPASSes the RLS that schema.sql enables with
// no policies), and GoTrue's login role. Idempotent — runs every boot.
async function bootstrapRoles(withPg, dbPassword) {
  const pw = dbPassword.replace(/'/g, "''");
  await pgExec(withPg, `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login createrole; end if;
      if not exists (select from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
    end $$;
    alter role supabase_auth_admin with login password '${pw}';
    alter role authenticator with login password '${pw}' noinherit;
    grant anon, authenticated, service_role to authenticator;
    create schema if not exists auth authorization supabase_auth_admin;
    -- GoTrue's migrator creates its own schema_migrations table WITHOUT a
    -- schema qualifier — it must land in auth, and since PG15 public no
    -- longer grants CREATE to non-owners anyway. The supabase image sets
    -- exactly this search_path on the auth admin role.
    alter role supabase_auth_admin set search_path = auth;
  `, "role bootstrap");
}

function listMigrations(backendDir) {
  const migrationsDir = path.join(backendDir, "migrations");
  return fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];
}

// Fresh database: apply schema.sql and record every shipped migration as
// already-contained-in-schema (the repo's stated contract: schema.sql
// converges with migrations, CI-enforced by schema-drift.yml). Existing
// database: apply only migrations the ledger hasn't seen. Then the
// service_role grants, which must re-run after any migration that created
// tables.
async function applySchema(withPg, backendDir, status = () => {}) {
  await pgExec(withPg, `
    create table if not exists public.mike_schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `, "migration ledger");
  const migrations = listMigrations(backendDir);
  const applied = new Set(
    await withPg(async (c) =>
      (await c.query("select name from public.mike_schema_migrations")).rows.map((r) => r.name),
    ),
  );

  const fresh =
    (await pgValue(withPg, "select to_regclass('public.user_profiles') is null;")) === "true";
  if (fresh) {
    status("Setting up the product schema…");
    await pgExecFile(withPg,
      fs.readFileSync(path.join(backendDir, "schema.sql"), "utf8"), "schema.sql");
    const values = migrations.map((m) => `('${m}')`).join(",");
    if (values) {
      await pgExec(withPg,
        `insert into public.mike_schema_migrations (name) values ${values} on conflict do nothing;`,
        "migration baseline");
    }
  } else {
    for (const m of migrations) {
      if (applied.has(m)) continue;
      status(`Applying update ${m}…`);
      await pgExecFile(withPg,
        fs.readFileSync(path.join(backendDir, "migrations", m), "utf8"), m);
      await pgExec(withPg,
        `insert into public.mike_schema_migrations (name) values ('${m}') on conflict do nothing;`,
        "migration ledger insert");
    }
  }

  await pgExec(withPg, `
    grant usage on schema public to service_role;
    grant all privileges on all tables in schema public to service_role;
    grant all privileges on all sequences in schema public to service_role;
  `, "service_role grants");
}

module.exports = { pgValue, pgExec, pgExecFile, bootstrapRoles, listMigrations, applySchema };
