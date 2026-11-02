import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

// Opt in with MIKE_TEST_POSTGRES_CONTAINER=supabase_db_backend. The existing
// application database is never touched: this suite owns a disposable DB.
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const database = `mike_test_private_access_${process.pid}_${Date.now()}`;
function sql(query: string) {
    execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-Xq"], {
        input: query, encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"],
    });
}
describe.skipIf(!container)("private organization content in PostgreSQL", () => {
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
    it("preserves the permission, scope, revocation and atomic audit boundaries on fresh installs and migration replay", () => {
        const migration = readFileSync(resolve(process.cwd(), "migrations/20261014_04_org_private_content_access.sql"), "utf8");
        const assertions = readFileSync(resolve(process.cwd(), "src/modules/orgs/__tests__/orgs.privateContent.sql"), "utf8");
        const auditMigration = readFileSync(resolve(process.cwd(), "migrations/20261014_05_audit_private_content_access.sql"), "utf8");
        const auditAssertions = readFileSync(resolve(process.cwd(), "src/modules/orgs/__tests__/orgs.auditPrivateContent.sql"), "utf8");
        const paginationMigration = readFileSync(resolve(process.cwd(), "migrations/20261014_08_paginate_organization_audit.sql"), "utf8");
        const paginationAssertions = readFileSync(resolve(process.cwd(), "src/modules/orgs/__tests__/orgs.auditPagination.sql"), "utf8");
        sql(assertions);
        sql(auditAssertions);
        sql(paginationAssertions);
        sql(migration);
        sql(auditMigration);
        sql(auditMigration);
        sql(paginationMigration);
        sql(paginationMigration);
        sql(assertions);
        sql(auditAssertions);
        sql(paginationAssertions);
    }, 60_000);
});
