// The local stack supervisor — docker-compose reimplemented as a process
// tree, so `Mike.app` can run the entire product on one Mac with nothing
// installed.
//
// It boots, in dependency order (mirroring compose's depends_on/healthcheck
// chain): Postgres → GoTrue (runs its own auth migrations) → product schema
// bootstrap + migration ledger → PostgREST → gateway proxy → backend →
// frontend. All ports are loopback-only. Every child's stdout/stderr goes to
// a log file under userData/local/logs.
//
// The web app and backend run byte-identical to the compose stack — this
// module replaces docker-compose.yml, nothing else. Where a step here looks
// odd, the compose file is the reference (db-init's wait-for-auth.users,
// roles.sql, gateway.conf, the backend env block).

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const {
  PORTS,
  FRONTEND_URL,
  GATEWAY_URL,
  BACKEND_URL,
  stackPaths,
  dataPaths,
} = require("./config");
const { loadOrCreateSecrets } = require("./secrets");
const { startGateway } = require("./gateway");

const children = []; // [{name, proc}] in boot order
let gatewayServer = null;
let running = false;

function log(dirs, name) {
  const file = fs.openSync(path.join(dirs.logs, `${name}.log`), "a");
  return file;
}

function spawnService(name, bin, args, { env, cwd, dirs }) {
  const out = log(dirs, name);
  const proc = spawn(bin, args, {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["ignore", out, out],
  });
  children.push({ name, proc });
  return proc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(name, probe, { timeoutMs = 60_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (err) {
      lastErr = err;
    }
    // A crashed child never becomes healthy — fail fast with its name so the
    // error page can point at the right log file.
    const dead = children.find((c) => c.proc.exitCode !== null);
    if (dead) {
      throw new Error(`${dead.name} exited with code ${dead.proc.exitCode} while waiting for ${name}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${name}${lastErr ? `: ${lastErr.message}` : ""}`);
}

function httpOk(url, allow = [200]) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(allow.includes(res.statusCode));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// --- Postgres helpers -------------------------------------------------------
// The bundled zonky Postgres ships only initdb/pg_ctl/postgres — no psql, no
// pg_isready — so all SQL goes through the pure-JS `pg` client instead.
// query() without parameters uses the simple protocol, which accepts
// multi-statement strings (schema.sql, migration files) exactly like
// `psql -f` — except wrapped in one implicit transaction, which is fine
// here: nothing in schema.sql/migrations is non-transactional (no
// CONCURRENTLY/VACUUM), and all-or-nothing per file is what a migration
// runner wants anyway.

const { Client } = require("pg");

async function withPg(secrets, fn) {
  const client = new Client({
    host: "127.0.0.1",
    port: PORTS.postgres,
    user: "postgres",
    password: secrets.dbPassword,
    database: "postgres",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function pgValue(secrets, sql) {
  return withPg(secrets, async (client) => {
    const res = await client.query(sql);
    const row = res.rows?.[0];
    return row ? String(Object.values(row)[0]) : "";
  });
}

async function pgExec(secrets, sql, label) {
  try {
    await withPg(secrets, (client) => client.query(sql));
  } catch (err) {
    throw new Error(`${label ?? "sql"} failed: ${String(err.message).slice(0, 2000)}`);
  }
}

async function pgReachable(secrets) {
  try {
    await withPg(secrets, (client) => client.query("select 1"));
    return true;
  } catch {
    return false;
  }
}

// The pg dist relies on version-name dylib symlinks (libzstd.1.dylib →
// libzstd.1.5.7.dylib). npm tarballs can't carry symlinks (the fetch script
// hydrates them from pg-symlinks.json) and packaging can drop them again —
// so hydrate idempotently at boot from the same manifest the npm package
// ships. Skips silently when the links already exist.
function hydratePgSymlinks(paths) {
  const pgRoot = path.dirname(paths.pgBin);
  const manifest = path.join(pgRoot, "pg-symlinks.json");
  if (!fs.existsSync(manifest)) return;
  for (const link of JSON.parse(fs.readFileSync(manifest, "utf8"))) {
    const src = link.source.replace(/^native\//, "");
    const dst = path.join(pgRoot, link.target.replace(/^native\//, ""));
    if (fs.existsSync(dst)) continue;
    try {
      fs.symlinkSync(
        path.relative(path.dirname(dst), path.join(pgRoot, src)),
        dst,
      );
    } catch { /* read-only resources with links intact, or a race — fine */ }
  }
}

function initdbIfNeeded(paths, dirs, secrets, status) {
  if (fs.existsSync(path.join(dirs.pgdata, "PG_VERSION"))) return;
  status("Creating local database (first run)…");
  const pwfile = path.join(dirs.root, ".pgpw");
  fs.writeFileSync(pwfile, secrets.dbPassword + "\n", { mode: 0o600 });
  try {
    const res = spawnSync(
      path.join(paths.pgBin, "initdb"),
      ["-D", dirs.pgdata, "-U", "postgres", "-E", "UTF8",
       "--auth=scram-sha-256", `--pwfile=${pwfile}`],
      { encoding: "utf8" },
    );
    if (res.status !== 0) {
      throw new Error(`initdb failed: ${(res.stderr || "").slice(0, 2000)}`);
    }
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
}

// Everything the supabase/postgres image pre-creates that this stack relies
// on, distilled: the role ladder (authenticator can wear anon/authenticated/
// service_role; service_role BYPASSes the RLS that schema.sql enables with
// no policies), and GoTrue's login role. Idempotent — runs every boot.
async function bootstrapRoles(secrets) {
  const pw = secrets.dbPassword.replace(/'/g, "''");
  await pgExec(secrets, `
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

// db-init's job plus a real upgrade story. Fresh database: apply schema.sql
// and record every shipped migration as already-contained-in-schema (the
// repo's stated contract: schema.sql converges with migrations, CI-enforced).
// Existing database: apply only migrations the ledger hasn't seen. Then the
// service_role grants, which must re-run after any migration that created
// tables.
async function applySchema(paths, dirs, secrets, status) {
  const backend = paths.backendDir;
  await pgExec(secrets, `
    create table if not exists public.mike_schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `, "migration ledger");
  const migrationsDir = path.join(backend, "migrations");
  const migrations = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];
  const applied = new Set(
    await withPg(secrets, async (c) =>
      (await c.query("select name from public.mike_schema_migrations")).rows.map((r) => r.name),
    ),
  );

  const fresh =
    (await pgValue(secrets, "select to_regclass('public.user_profiles') is null;")) === "true";
  if (fresh) {
    status("Setting up the product schema…");
    await pgExec(secrets,
      fs.readFileSync(path.join(backend, "schema.sql"), "utf8"), "schema.sql");
    const values = migrations.map((m) => `('${m}')`).join(",");
    if (values) {
      await pgExec(secrets,
        `insert into public.mike_schema_migrations (name) values ${values} on conflict do nothing;`,
        "migration baseline");
    }
  } else {
    for (const m of migrations) {
      if (applied.has(m)) continue;
      status(`Applying update ${m}…`);
      await pgExec(secrets,
        fs.readFileSync(path.join(migrationsDir, m), "utf8"), m);
      await pgExec(secrets,
        `insert into public.mike_schema_migrations (name) values ('${m}') on conflict do nothing;`,
        "migration ledger insert");
    }
  }

  await pgExec(secrets, `
    grant usage on schema public to service_role;
    grant all privileges on all tables in schema public to service_role;
    grant all privileges on all sequences in schema public to service_role;
  `, "service_role grants");
}

function findSoffice() {
  const candidate = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  return fs.existsSync(candidate) ? candidate : null;
}

// --- The boot sequence ------------------------------------------------------

async function startLocalStack(app, status = () => {}) {
  if (running) return { frontendUrl: FRONTEND_URL };
  const paths = stackPaths(app);
  const dirs = dataPaths(app);
  for (const d of [dirs.root, dirs.storage, dirs.logs]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const secrets = loadOrCreateSecrets(dirs.secretsFile);

  try {
    // 1. Postgres
    hydratePgSymlinks(paths);
    initdbIfNeeded(paths, dirs, secrets, status);
    status("Starting database…");
    // A previous hard kill (crash, force-quit) can leave a stale pid file
    // that blocks startup; postgres validates it itself, but only if the
    // stale process id is not in use. Remove it only when no postgres owns it.
    const pidFile = path.join(dirs.pgdata, "postmaster.pid");
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8").split("\n")[0]);
      try {
        process.kill(pid, 0); // alive — a previous instance still runs
      } catch {
        fs.rmSync(pidFile, { force: true });
      }
    }
    spawnService("postgres", path.join(paths.pgBin, "postgres"),
      ["-D", dirs.pgdata, "-p", String(PORTS.postgres),
       "-c", "listen_addresses=127.0.0.1", "-k", ""],
      { dirs });
    await waitFor("postgres", () => pgReachable(secrets));
    await bootstrapRoles(secrets);

    // 2. GoTrue — applies its own migrations (creates auth.users) at boot.
    status("Starting auth…");
    // No args: the root command migrates then serves, exactly what the
    // supabase/gotrue container entrypoint does.
    spawnService("gotrue", paths.gotrue, [], {
      dirs,
      cwd: path.dirname(paths.gotrue),
      env: {
        GOTRUE_API_HOST: "127.0.0.1",
        PORT: String(PORTS.gotrue),
        GOTRUE_API_PORT: String(PORTS.gotrue),
        API_EXTERNAL_URL: GATEWAY_URL,
        GOTRUE_DB_DRIVER: "postgres",
        GOTRUE_DB_NAMESPACE: "auth",
        GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${encodeURIComponent(secrets.dbPassword)}@127.0.0.1:${PORTS.postgres}/postgres`,
        GOTRUE_DB_MIGRATIONS_PATH: paths.gotrueMigrations,
        GOTRUE_SITE_URL: FRONTEND_URL,
        GOTRUE_URI_ALLOW_LIST: "*",
        GOTRUE_JWT_SECRET: secrets.jwtSecret,
        GOTRUE_JWT_EXP: "3600",
        GOTRUE_JWT_AUD: "authenticated",
        GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
        GOTRUE_JWT_ADMIN_ROLES: "service_role",
        GOTRUE_DISABLE_SIGNUP: "false",
        GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
        GOTRUE_EXTERNAL_PHONE_ENABLED: "false",
        // Autoconfirm keeps signup fully offline. There is no SMTP server:
        // password recovery by email is documented as unavailable in local
        // mode (the connect screen says so) — GoTrue only touches SMTP when
        // asked to actually send.
        GOTRUE_MAILER_AUTOCONFIRM: "true",
        GOTRUE_SMTP_ADMIN_EMAIL: "admin@mike.local",
        GOTRUE_SMTP_SENDER_NAME: "Mike",
        GOTRUE_MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify",
        GOTRUE_MAILER_URLPATHS_RECOVERY: "/auth/v1/verify",
        GOTRUE_MAILER_URLPATHS_INVITE: "/auth/v1/verify",
        GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: "/auth/v1/verify",
      },
    });
    await waitFor("gotrue (auth.users)", async () =>
      (await pgValue(secrets, "select to_regclass('auth.users') is not null;")) === "true"
      && (await httpOk(`http://127.0.0.1:${PORTS.gotrue}/health`)),
      { timeoutMs: 120_000 });

    // 3. Product schema
    await applySchema(paths, dirs, secrets, status);

    // 4. PostgREST
    status("Starting data API…");
    spawnService("postgrest", paths.postgrest, [], {
      dirs,
      env: {
        PGRST_DB_URI: `postgres://authenticator:${encodeURIComponent(secrets.dbPassword)}@127.0.0.1:${PORTS.postgres}/postgres`,
        PGRST_DB_SCHEMAS: "public",
        PGRST_DB_ANON_ROLE: "anon",
        PGRST_JWT_SECRET: secrets.jwtSecret,
        PGRST_SERVER_HOST: "127.0.0.1",
        PGRST_SERVER_PORT: String(PORTS.postgrest),
      },
    });
    await waitFor("postgrest", () =>
      httpOk(`http://127.0.0.1:${PORTS.postgrest}/`, [200, 401]));

    // 5. Gateway proxy (in-process)
    gatewayServer = await startGateway({ anonKey: secrets.anonKey });

    // 6. Backend — Electron's own binary in Node mode, so no separate
    // runtime ships with the app.
    status("Starting Mike services…");
    const soffice = findSoffice();
    spawnService("backend", process.execPath,
      [path.join(paths.backendDir, "dist", "index.js")], {
      dirs,
      cwd: paths.backendDir,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(PORTS.backend),
        FRONTEND_URL,
        SUPABASE_URL: GATEWAY_URL,
        SUPABASE_SECRET_KEY: secrets.serviceRoleKey,
        STORAGE_DRIVER: "fs",
        STORAGE_FS_ROOT: dirs.storage,
        BACKEND_PUBLIC_URL: BACKEND_URL,
        DOWNLOAD_SIGNING_SECRET: secrets.downloadSigningSecret,
        USER_API_KEYS_ENCRYPTION_SECRET: secrets.userApiKeysEncryptionSecret,
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
        ...(soffice ? { SOFFICE_BINARY_PATH: soffice } : {}),
      },
    });
    await waitFor("backend", () => httpOk(`${BACKEND_URL}/health`));

    // 7. Frontend (Next standalone server)
    const serverJs = path.join(paths.frontendStandalone, "server.js");
    spawnService("frontend", process.execPath, [serverJs], {
      dirs,
      cwd: paths.frontendStandalone,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(PORTS.frontend),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
      },
    });
    await waitFor("frontend", () => httpOk(`${FRONTEND_URL}/login`, [200, 307, 308]));

    running = true;
    status("Ready");
    return { frontendUrl: FRONTEND_URL };
  } catch (err) {
    await stopLocalStack(paths);
    throw err;
  }
}

async function stopLocalStack(paths) {
  running = false;
  if (gatewayServer) {
    try { gatewayServer.close(); } catch { /* already closed */ }
    gatewayServer = null;
  }
  // Reverse boot order; postgres last so nothing loses its database mid-write.
  for (const { name, proc } of [...children].reverse()) {
    if (proc.exitCode !== null) continue;
    try {
      // SIGINT is postgres "fast shutdown" (rollback + clean stop) and a
      // normal terminate for the Node/Go services.
      proc.kill(name === "postgres" ? "SIGINT" : "SIGTERM");
    } catch { /* already gone */ }
  }
  const deadline = Date.now() + 10_000;
  while (children.some((c) => c.proc.exitCode === null) && Date.now() < deadline) {
    await sleep(150);
  }
  for (const { proc } of children) {
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  children.length = 0;
}

function localStackRunning() {
  return running;
}

module.exports = { startLocalStack, stopLocalStack, localStackRunning };
