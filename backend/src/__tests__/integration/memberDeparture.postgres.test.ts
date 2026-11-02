import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Opt in with MIKE_TEST_POSTGRES_CONTAINER=supabase_db_backend. All writes
// target a disposable database; the container's application DB is untouched.
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const database = `mike_test_departure_${process.pid}_${Date.now()}`;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (n: number) => `'${uid(n)}'`;
const sql = (query: string): string => execFileSync("docker", [
    "exec", "-i", container!, "psql", "-U", "postgres", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-XqAt",
], { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const count = (table: string) => Number(sql(`select count(*) from public.${table}`));
const preview = (members: number[] = [2]) => JSON.parse(sql(`
    select coalesce(json_agg(x order by kind, item_id), '[]')
    from public.org_members_departure_items(${q(10)}, array[${members.map(q)}]::uuid[]) x;
`)) as { kind: string; item_id: string; title: string | null; disposition: string }[];
const remove = (member: number) => sql(`delete from public.org_members
    where org_id=${q(10)} and user_id=${q(member)};`);

describe.skipIf(!container)("member departures in PostgreSQL", () => {
    let created = false;
    beforeAll(() => {
        execFileSync("docker", ["exec", container!, "createdb", "-U", "postgres", database]);
        created = true;
        sql(`create schema auth;
            create table auth.users (id uuid primary key, email text,
                raw_user_meta_data jsonb default '{}', created_at timestamptz default now());`);
        sql(readFileSync(resolve(process.cwd(), "schema.sql"), "utf8"));

        // Exercise the actual upgrade from the previous function definitions,
        // including its AFTER trigger, then verify that reapplication is safe.
        const oldHandover = readFileSync(resolve(process.cwd(), "migrations/20261013_01_member_handover.sql"), "utf8");
        const oldLibrary = readFileSync(resolve(process.cwd(), "migrations/20261013_03_workspace_library.sql"), "utf8");
        for (const [source, name] of [
            [oldHandover, "org_member_sole_owned_items"],
            [oldHandover, "assign_org_member_items"],
            [oldLibrary, "org_member_private_standalone"],
            [oldLibrary, "cleanup_removed_org_member_overrides"],
        ]) {
            const start = source.indexOf(`create or replace function public.${name}(`);
            expect(start).toBeGreaterThanOrEqual(0);
            sql(source.slice(start, source.indexOf("$$;", start) + 3));
        }
        sql(`drop trigger org_members_cleanup_access_overrides on public.org_members;
            create trigger org_members_cleanup_access_overrides after delete on public.org_members
                for each row execute procedure public.cleanup_removed_org_member_overrides();
            drop function public.org_members_departure_items(uuid, uuid[]);`);
        const migration = readFileSync(resolve(process.cwd(), "migrations/20261013_04_public_member_handover.sql"), "utf8");
        sql(migration);
        sql(migration);
    }, 60_000);

    afterAll(() => {
        if (created) execFileSync("docker", ["exec", container!, "dropdb", "-U", "postgres", "--force", database]);
    });

    beforeEach(() => {
        sql(`truncate auth.users, public.organizations, public.db_jobs cascade;
            insert into auth.users(id,email) values
                (${q(1)},'owner@example.test'), (${q(2)},'departing@example.test'),
                (${q(3)},'remaining@example.test');
            insert into public.organizations(id,name,created_by) values (${q(10)},'Test org',${q(1)});
            insert into public.org_members(org_id,user_id,role) values
                (${q(10)},${q(1)},'owner'), (${q(10)},${q(2)},'member'), (${q(10)},${q(3)},'member');`);
    });

    it("transfers only public items and never exposes private titles", () => {
        sql(`insert into public.projects(id,org_id,user_id,name,visibility) values
                (${q(20)},${q(10)},${q(2)},'Public project','organization'),
                (${q(21)},${q(10)},${q(2)},'Secret project','private');
            insert into public.workflows(id,org_id,user_id,title,type,visibility) values
                (${q(30)},${q(10)},${q(2)},'Public workflow','chat','organization'),
                (${q(31)},${q(10)},${q(2)},'Secret workflow','chat','private');`);
        expect(preview()).toEqual([
            { kind: "project", item_id: uid(20), title: "Public project", disposition: "transfer" },
            { kind: "project", item_id: uid(21), title: null, disposition: "delete" },
            { kind: "workflow", item_id: uid(30), title: "Public workflow", disposition: "transfer" },
            { kind: "workflow", item_id: uid(31), title: null, disposition: "delete" },
        ]);
        expect(sql(`select public.assign_org_member_items(${q(10)},${q(2)},${q(3)},${q(1)})`)).toBe("2");
        expect(sql("select project_id from public.project_org_access_overrides")).toBe(uid(20));
        expect(sql("select workflow_id from public.workflow_org_access_overrides")).toBe(uid(30));
        remove(2);
        expect(sql("select id from public.projects")).toBe(uid(20));
        expect(sql("select id from public.workflows")).toBe(uid(30));
    });

    it("accepts the organization owner as successor without redundant overrides", () => {
        sql(`insert into public.projects(id,org_id,user_id,name,visibility)
            values (${q(20)},${q(10)},${q(2)},'Public','organization')`);
        expect(sql(`select public.assign_org_member_items(${q(10)},${q(2)},${q(1)},${q(1)})`)).toBe("1");
        expect(count("project_org_access_overrides")).toBe(0);
        remove(2);
        expect(count("projects")).toBe(1);
    });

    it("preserves private co-owned work until its last owner leaves, including grant owners", () => {
        sql(`insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Private');
            insert into public.workflows(id,org_id,user_id,title,type) values (${q(30)},${q(10)},${q(2)},'Private','chat');
            insert into public.project_org_access_overrides(project_id,org_id,user_id,role)
                values (${q(20)},${q(10)},${q(3)},'owner');
            insert into public.workflow_org_access_overrides(workflow_id,org_id,user_id,role)
                values (${q(30)},${q(10)},${q(3)},'owner');`);
        expect(preview()).toEqual([]);
        expect(preview([2, 3])).toHaveLength(2);
        remove(2);
        expect(count("projects")).toBe(1);
        expect(count("workflows")).toBe(1);
        expect(preview([3])).toHaveLength(2);
        remove(3);
        expect(count("projects")).toBe(0);
        expect(count("workflows")).toBe(0);
    });

    it("does not treat editor or viewer grants as remaining owners", () => {
        sql(`insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Private');
            insert into public.workflows(id,org_id,user_id,title,type) values (${q(30)},${q(10)},${q(2)},'Private','chat');
            insert into public.project_org_access_overrides(project_id,org_id,user_id,role)
                values (${q(20)},${q(10)},${q(3)},'editor');
            insert into public.workflow_org_access_overrides(workflow_id,org_id,user_id,role)
                values (${q(30)},${q(10)},${q(3)},'viewer');`);
        remove(2);
        expect(count("projects")).toBe(0);
        expect(count("workflows")).toBe(0);
    });

    it("preserves standalone shared work until the last grant owner leaves", () => {
        sql(`insert into public.chats(id,org_id,user_id,title) values (${q(40)},${q(10)},${q(2)},'Private');
            insert into public.tabular_reviews(id,org_id,user_id,title) values (${q(50)},${q(10)},${q(2)},'Private');
            insert into public.chat_access_grants(chat_id,email,role) values (${q(40)},'remaining@example.test','owner');
            insert into public.tabular_review_access_grants(tabular_review_id,email,role)
                values (${q(50)},'remaining@example.test','owner');`);
        expect(preview()).toEqual([]);
        remove(2);
        expect(count("chats")).toBe(1);
        expect(count("tabular_reviews")).toBe(1);
        remove(3);
        expect(count("chats")).toBe(0);
        expect(count("tabular_reviews")).toBe(0);
    });

    it("cascades item contents and queues durable stored-file cleanup", () => {
        sql(`insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Private');
            insert into public.workflows(id,org_id,user_id,title,type) values (${q(30)},${q(10)},${q(2)},'Private','chat');
            insert into public.chats(id,org_id,user_id,project_id) values (${q(40)},${q(10)},${q(2)},${q(20)});
            insert into public.tabular_reviews(id,org_id,user_id,project_id) values (${q(50)},${q(10)},${q(2)},${q(20)});
            insert into public.documents(id,org_id,user_id,project_id,workflow_id,library_kind) values
                (${q(60)},${q(10)},${q(2)},${q(20)},null,'file'),
                (${q(61)},${q(10)},${q(2)},null,${q(30)},'workflow_asset'),
                (${q(62)},${q(10)},${q(2)},null,null,'file');
            insert into public.document_versions(document_id,storage_path) values
                (${q(60)},'test/project.pdf'), (${q(61)},'test/workflow.pdf'), (${q(62)},'test/standalone.pdf');`);
        remove(2);
        for (const table of ["projects", "workflows", "chats", "tabular_reviews", "documents", "document_versions"]) {
            expect(count(table), table).toBe(0);
        }
        expect(Number(sql("select count(*) from public.db_jobs where kind='document.cleanup'"))).toBe(3);
    });

    it("keeps personal work and protects the last organization owner", () => {
        sql(`insert into public.projects(id,org_id,user_id,name) values
            (${q(20)},${q(10)},${q(1)},'Owner private'),
            (${q(21)},(select id from public.organizations where personal_user_id=${q(2)}),${q(2)},'Personal');`);
        expect(() => remove(1)).toThrow();
        expect(count("projects")).toBe(2);
        remove(2);
        expect(count("projects")).toBe(2);
    });

    it("restricts the departure preview RPC to the backend role", () => {
        for (const role of ["anon", "authenticated"]) {
            expect(sql(`select has_function_privilege('${role}',
                'public.org_members_departure_items(uuid,uuid[])','execute')`)).toBe("f");
        }
        expect(sql(`select has_function_privilege('service_role',
            'public.org_members_departure_items(uuid,uuid[])','execute')`)).toBe("t");
    });
});
