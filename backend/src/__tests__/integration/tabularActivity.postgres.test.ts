import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Opt in with MIKE_TEST_POSTGRES_CONTAINER=supabase_db_backend. Only writes
// to disposable databases, never the container's application database.
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (n: number) => `'${uid(n)}'`;

describe.skipIf(!container).each(["fresh", "upgraded"])("review activity in PostgreSQL (%s)", (mode) => {
    const database = `mike_review_activity_${mode}_${process.pid}_${Date.now()}`;
    const sql = (query: string): string => execFileSync("docker", [
        "exec", "-i", container!, "psql", "-U", "postgres", "-d", database,
        "-v", "ON_ERROR_STOP=1", "-XqAt",
    ], { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const stamp = () => sql(`select updated_at from public.tabular_reviews where id=${q(10)}`);
    const claim = (version: string, generation = 20) => sql(`select public.begin_tabular_review_generation(${q(10)}, '${version}', ${q(generation)}, 300)`);
    const firstReview = () => sql(`select id from public.get_tabular_reviews_overview(
        ${q(1)}::text, 'owner@example.test', null, 'all', 1, 0, null, 'updated', 'desc', 'personal')`);
    let created = false;

    beforeAll(() => {
        execFileSync("docker", ["exec", container!, "createdb", "-U", "postgres", database]);
        created = true;
        sql(`create schema auth;
            create table auth.users (id uuid primary key, email text,
                raw_user_meta_data jsonb default '{}', created_at timestamptz default now());`);
        sql(readFileSync(resolve("schema.sql"), "utf8"));
        if (mode === "upgraded") {
            sql(readFileSync(resolve("migrations/20260822_01_tabular_generation_lease.sql"), "utf8"));
            const migration = readFileSync(resolve("migrations/20261016_01_tabular_review_generation_activity.sql"), "utf8");
            sql(migration);
            sql(migration);
        }
    }, 60_000);

    afterAll(() => {
        if (created) execFileSync("docker", ["exec", container!, "dropdb", "-U", "postgres", "--force", database]);
    });

    beforeEach(() => {
        sql(`truncate auth.users, public.organizations, public.db_jobs cascade;
            insert into auth.users(id,email) values (${q(1)},'owner@example.test');
            insert into public.tabular_reviews(id,user_id,title,created_at,updated_at) values
                (${q(10)},${q(1)},'Old review','2020-01-01','2020-01-01'),
                (${q(11)},${q(1)},'Recent review','2021-01-01','2021-01-01');`);
    });

    it("promotes a run immediately, and records completion and subsequent reruns", () => {
        const original = stamp();
        expect(firstReview()).toBe(uid(11));
        expect(claim(original)).toBe("started");
        const started = stamp();
        expect(Date.parse(started)).toBeGreaterThan(Date.parse(original));
        expect(firstReview()).toBe(uid(10));
        expect(sql(`select public.finish_tabular_review_generation(${q(10)},${q(20)})`)).toBe("t");
        const finished = stamp();
        expect(Date.parse(finished)).toBeGreaterThan(Date.parse(started));
        expect(claim(finished, 21)).toBe("started");
        expect(Date.parse(stamp())).toBeGreaterThan(Date.parse(finished));
    });

    it("does not promote lease heartbeats or rejected stale/concurrent requests", () => {
        const original = stamp();
        expect(claim(original)).toBe("started");
        const started = stamp();
        expect(sql(`select public.renew_tabular_review_generation(${q(10)},${q(20)},300)`)).toBe("t");
        expect(stamp()).toBe(started);
        expect(claim(original, 21)).toBe("running");
        expect(stamp()).toBe(started);
        expect(sql(`select public.finish_tabular_review_generation(${q(10)},${q(21)})`)).toBe("");
        expect(stamp()).toBe(started);
        sql(`select public.finish_tabular_review_generation(${q(10)},${q(20)})`);
        const finished = stamp();
        expect(claim(original, 21)).toBe("stale");
        expect(stamp()).toBe(finished);
    });

    it("keeps lease RPCs restricted to the backend role", () => {
        for (const signature of [
            "begin_tabular_review_generation(uuid,timestamptz,uuid,integer)",
            "finish_tabular_review_generation(uuid,uuid)",
        ]) {
            for (const role of ["anon", "authenticated"]) {
                expect(sql(`select has_function_privilege('${role}', 'public.${signature}', 'execute')`)).toBe("f");
            }
            expect(sql(`select has_function_privilege('service_role', 'public.${signature}', 'execute')`)).toBe("t");
        }
    });
});
