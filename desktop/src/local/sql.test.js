const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { splitStatements, runSqlFile, TRANSACTION_BLOCK_ERROR } = require("./sql");

// The migration that broke every existing installation's upgrade: main's
// 20260921_01 (PR #505) drops/creates indexes CONCURRENTLY, which Postgres
// refuses inside the implicit transaction the simple protocol wraps a
// multi-statement query in.
const MIGRATION = path.join(__dirname, "..", "..", "..", "backend", "migrations", "20260921_01_chat_activity.sql");

test("splitStatements keeps dollar-quoted bodies, strings and comments intact", () => {
  const sql = `
    -- leading comment; with a semicolon
    create table t (a text default 'x;y', "weird;name" int);
    /* block; comment /* nested; */ still comment */
    create function f() returns void language plpgsql as $$
    begin
      perform 1; perform 2;
    end;
    $$;
    create function g() returns text language sql as $body$ select 'a;b'; $body$;
    select E'it\\'s; fine';
    drop index concurrently if exists idx;
  `;
  const parts = splitStatements(sql);
  assert.equal(parts.length, 5);
  assert.match(parts[0], /create table t/);
  assert.match(parts[0], /^-- leading comment; with a semicolon/);
  assert.match(parts[1], /^\/\* block; comment \/\* nested; \*\/ still comment \*\//);
  assert.match(parts[1], /perform 1; perform 2;\s*end;\s*\$\$$/);
  assert.match(parts[2], /\$body\$ select 'a;b'; \$body\$$/);
  assert.match(parts[3], /^select E'it\\'s; fine'$/);
  assert.equal(parts[4], "drop index concurrently if exists idx");
});

test("the real CONCURRENTLY migration splits into whole statements", () => {
  const parts = splitStatements(fs.readFileSync(MIGRATION, "utf8"));
  const concurrent = parts.filter((p) => /concurrently/i.test(p));
  assert.equal(concurrent.length, 2);
  for (const p of concurrent) assert.doesNotMatch(p, /\n\s*(create|alter|drop)\s/i, "concurrent statement must stand alone");
  const functions = parts.filter((p) => /^create or replace function/i.test(p));
  assert.equal(functions.length, 3);
  for (const p of functions) assert.match(p, /\$\$\s*$/, "function body must end with its own dollar quote");
});

test("runSqlFile applies a file in one transaction when Postgres accepts it", async () => {
  const calls = [];
  const result = await runSqlFile(async (text) => { calls.push(text); }, "select 1; select 2;");
  assert.equal(result.mode, "transaction");
  assert.equal(calls.length, 1);
});

test("runSqlFile falls back to statement-by-statement autocommit on SQLSTATE 25001", async () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const calls = [];
  let first = true;
  const query = async (text) => {
    calls.push(text);
    if (first) {
      first = false;
      const err = new Error("DROP INDEX CONCURRENTLY cannot run inside a transaction block");
      err.code = TRANSACTION_BLOCK_ERROR;
      throw err;
    }
    if (/concurrently/i.test(text) && /;[\s\S]*\S/.test(text.replace(/\$\$[\s\S]*?\$\$/g, ""))) {
      throw new Error("a CONCURRENTLY statement was batched with other statements: " + text.slice(0, 80));
    }
  };
  const result = await runSqlFile(query, sql);
  assert.equal(result.mode, "autocommit");
  assert.equal(calls[0], sql, "first attempt is the whole file");
  assert.equal(calls.length - 1, result.statements);
  assert.ok(result.statements > 10);
});

test("runSqlFile does not mask other errors as a reason to replay", async () => {
  const err = new Error("relation does not exist");
  err.code = "42P01";
  let calls = 0;
  await assert.rejects(runSqlFile(async () => { calls += 1; throw err; }, "select 1; select 2;"), /relation does not exist/);
  assert.equal(calls, 1);
});
