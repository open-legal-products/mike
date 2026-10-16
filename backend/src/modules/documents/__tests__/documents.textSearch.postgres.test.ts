import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

// Uses the same disposable-database convention as organization lifecycle tests.
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const database = `mike_test_document_text_${process.pid}_${Date.now()}`;
function sql(query: string) {
  execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-Xq"], {
    input: query, encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"],
  });
}
describe.skipIf(!container)("document text lifecycle in PostgreSQL", () => {
  let created = false;
  beforeAll(() => {
    execFileSync("docker", ["exec", container!, "createdb", "-U", "postgres", database]);
    created = true;
    sql("create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());");
    sql(readFileSync(resolve(process.cwd(), "schema.sql"), "utf8"));
  }, 60_000);
  afterAll(() => {
    if (created) execFileSync("docker", ["exec", container!, "dropdb", "-U", "postgres", "--force", database]);
  });
  it("keeps backfill, revision publication, scopes, and permissions correct after migration replay", () => {
    const assertions = readFileSync(resolve(process.cwd(), "src/modules/documents/__tests__/documents.textSearch.sql"), "utf8");
    const migration = readFileSync(resolve(process.cwd(), "migrations/20261015_01_document_text_search.sql"), "utf8");
    sql(assertions); sql(migration); sql(migration); sql(assertions);
  }, 60_000);
});
