import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildUserAccountExport, buildUserChatsExport } from "../../modules/user/user.dataExport";
import { makeExportDb, type Row } from "../../modules/user/__tests__/user.dataExport.fixture";

// Opt in with MIKE_TEST_POSTGRES_CONTAINER=supabase_db_backend. All writes
// target a disposable database; the container's application DB is untouched.
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const database = `mike_test_retention_${process.pid}_${Date.now()}`;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (n: number) => `'${uid(n)}'`;
const sql = (query: string): string => execFileSync("docker", [
    "exec", "-i", container!, "psql", "-U", "postgres", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-XqAt",
], { input: `${query}\n\\q\n`, encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
const count = (table: string) => Number(sql(`select count(*) from public.${table}`));
const preview = (members: number[] = [2]) => JSON.parse(sql(`
    select coalesce(json_agg(x order by kind, item_id), '[]')
    from public.org_members_departure_items(${q(10)}, array[${members.map(q)}]::uuid[]) x;
`)) as { kind: string; item_id: string; title: string | null; disposition: string }[];

describe.skipIf(!container)("organization offboarding retention in PostgreSQL", () => {
    let created = false;
    beforeAll(() => {
        execFileSync("docker", ["exec", container!, "createdb", "-U", "postgres", database]);
        created = true;
        sql(`create schema auth;
            create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());`);
        sql(readFileSync(resolve(process.cwd(), "schema.sql"), "utf8"));
        const migration = readFileSync(resolve(process.cwd(), "migrations/20261013_05_org_departure_retention.sql"), "utf8");
        sql(migration);
        sql(migration);
        const listing = readFileSync(resolve(process.cwd(), "migrations/20261013_06_org_departure_listing.sql"), "utf8");
        sql(listing);
        sql(listing);
    }, 60_000);
    afterAll(() => {
        if (created) execFileSync("docker", ["exec", container!, "dropdb", "-U", "postgres", "--force", database]);
    });
    beforeEach(() => {
        sql(`truncate auth.users,public.organizations,public.db_jobs cascade;
            insert into auth.users(id,email) values (${q(1)},'owner@example.test'),(${q(2)},'departing@example.test'),
                (${q(3)},'remaining@example.test'),(${q(4)},'admin@example.test');
            insert into public.organizations(id,name,created_by) values (${q(10)},'Test org',${q(1)});
            insert into public.org_members(org_id,user_id,role) values (${q(10)},${q(1)},'owner'),
                (${q(10)},${q(2)},'member'),(${q(10)},${q(3)},'member'),(${q(10)},${q(4)},'admin');`);
    });
    const depart = (successor: number | null = null) => sql(`set role service_role; select public.remove_org_member(${q(10)},${q(2)},${q(4)},${successor ? q(successor) : 'null'});`);
    const archiveId = (item: number) => sql(`select id from public.org_departure_archives where item_id=${q(item)}`);
    const recover = (item: number, actor = 1, successor = 3) => sql(`set role service_role; select public.resolve_org_departure_archive(${q(10)},'${archiveId(item)}',${q(actor)},${q(successor)},false)`);

    it("bulk-transfers public and shared work, retains co-owned work, archives only unshared work", () => {
        sql(`insert into public.projects(id,org_id,user_id,name,visibility) values
            (${q(20)},${q(10)},${q(2)},'Public','organization'),(${q(21)},${q(10)},${q(2)},'Shared','private'),
            (${q(22)},${q(10)},${q(2)},'Private secret','private'),(${q(23)},${q(10)},${q(2)},'Co-owned','private');
            insert into public.project_org_access_overrides(project_id,org_id,user_id,role) values
            (${q(21)},${q(10)},${q(3)},'editor'),(${q(23)},${q(10)},${q(3)},'owner');`);
        expect(preview().find(i => i.item_id === uid(21))).toMatchObject({ disposition: "transfer", title: null });
        expect(preview().find(i => i.item_id === uid(22))).toMatchObject({ disposition: "archive", title: null });
        expect(preview().some(i => i.item_id === uid(23))).toBe(false);
        depart();
        expect(count("projects")).toBe(4);
        expect(count("org_departure_archives")).toBe(1);
        expect(sql(`select role from public.project_org_access_overrides where project_id=${q(21)} and user_id=${q(1)}`)).toBe("owner");
        expect(sql(`select role from public.project_org_access_overrides where project_id=${q(21)} and user_id=${q(3)}`)).toBe("editor");
        expect(sql(`select public.project_access_role(${q(22)},null,${q(10)},${q(1)},'owner@example.test') is null`)).toBe("t");
        expect(sql(`select public.project_access_role(${q(23)},null,${q(10)},${q(3)},'remaining@example.test')`)).toBe("owner");
        expect(sql(`select expires_at-archived_at from public.org_departure_archives`)).toBe("30 days");
        expect(count("org_departure_events")).toBe(4);
    });

    it("supports one successor for hundreds of shared items", () => {
        sql(`insert into public.projects(org_id,user_id,name,visibility)
            select ${q(10)},${q(2)},'Matter '||n,'organization' from generate_series(1,240) n;`);
        depart(3);
        expect(count("project_org_access_overrides")).toBe(240);
        expect(count("projects")).toBe(240);
        expect(count("org_departure_archives")).toBe(0);
    });

    it("preserves shared chats, reviews and referenced library files", () => {
        sql(`insert into public.chats(id,org_id,user_id,title) values (${q(40)},${q(10)},${q(2)},'Shared chat');
            insert into public.tabular_reviews(id,org_id,user_id,title) values (${q(50)},${q(10)},${q(2)},'Shared review');
            insert into public.chat_access_grants(chat_id,email,role) values (${q(40)},'remaining@example.test','editor');
            insert into public.tabular_review_access_grants(tabular_review_id,email,role) values (${q(50)},'remaining@example.test','viewer');
            insert into public.documents(id,org_id,user_id,library_kind) values (${q(60)},${q(10)},${q(2)},'file');
            insert into public.chat_messages(chat_id,role,files) values (${q(40)},'user','[{"document_id":"${uid(60)}"}]');`);
        depart();
        expect(count("org_departure_archives")).toBe(0);
        expect(sql(`select public.chat_access_role(${q(40)},null,null,${q(10)},${q(1)},'owner@example.test')`)).toBe("owner");
        expect(sql(`select public.review_access_role(${q(50)},null,null,${q(10)},${q(1)},'owner@example.test')`)).toBe("owner");
        expect(sql(`select user_id from public.documents where id=${q(60)}`)).toBe(uid(1));
    });

    it("does not export a retained review transcript after its creator leaves", async () => {
        sql(`insert into public.projects(id,org_id,user_id,name,visibility)
                values (${q(20)},${q(10)},${q(2)},'Shared project','organization');
            insert into public.tabular_reviews(id,project_id,user_id,title)
                values (${q(50)},${q(20)},${q(2)},'Team review'),(${q(51)},null,${q(2)},'Personal review');
            insert into public.tabular_review_chats(id,review_id,user_id,title)
                values (${q(40)},${q(50)},${q(2)},'Team transcript'),(${q(41)},${q(51)},${q(2)},'Personal transcript');`);
        depart();
        sql(`insert into public.tabular_review_chat_messages(id,chat_id,author_user_id,role,content)
                values (${q(70)},${q(40)},${q(1)},'user','"Written after removal"'),
                    (${q(71)},${q(41)},${q(2)},'user','"Personal message"');`);
        expect(sql(`select count(*) from public.org_members where org_id=${q(10)} and user_id=${q(2)}`)).toBe("0");
        expect(sql(`select public.review_access_role(${q(50)},${q(20)},null,${q(10)},${q(2)},'departing@example.test') is null`)).toBe("t");
        // Creator provenance remains on the transcript, despite loss of access.
        expect(sql(`select user_id from public.tabular_review_chats where id=${q(40)}`)).toBe(uid(2));

        // Run the real export and read-permission helpers against the rows
        // produced by PostgreSQL's removal transaction, without a REST server.
        const tables: Record<string, Row[]> = {};
        for (const table of ["organizations", "org_members", "projects", "tabular_reviews", "tabular_review_chats", "tabular_review_chat_messages"]) {
            tables[table] = JSON.parse(sql(`select coalesce(json_agg(t),'[]') from public.${table} t`));
        }
        const { db } = makeExportDb(tables);
        // Personal keeps the personal transcript.
        const account = await buildUserAccountExport(db, uid(2), "departing@example.test", null);
        const chats = await buildUserChatsExport(db, uid(2), "departing@example.test", null);
        for (const exported of [account, chats]) {
            expect(exported.tabular_review_chats.chats.map((row) => row.id)).toEqual([uid(41)]);
            expect(exported.tabular_review_chats.messages.map((row) => row.id)).toEqual([uid(71)]);
            expect(JSON.stringify(exported)).not.toContain("Written after removal");
        }
        // The organization's export no longer reaches the team transcript.
        const teamAccount = await buildUserAccountExport(db, uid(2), "departing@example.test", uid(10));
        const teamChats = await buildUserChatsExport(db, uid(2), "departing@example.test", uid(10));
        for (const exported of [teamAccount, teamChats]) {
            expect(exported.tabular_review_chats).toEqual({ chats: [], messages: [] });
            expect(JSON.stringify(exported)).not.toContain("Written after removal");
        }
    });

    it("archives containers with their files and allows only owners to recover them", () => {
        sql(`insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Secret');
            insert into public.documents(id,org_id,user_id,project_id) values (${q(60)},${q(10)},${q(2)},${q(20)});
            insert into public.document_versions(document_id,storage_path) values (${q(60)},'test/preserved.pdf');`);
        depart();
        expect(count("documents")).toBe(1);
        expect(count("document_versions")).toBe(1);
        expect(Number(sql(`select count(*) from public.db_jobs where kind='document.cleanup'`))).toBe(0);
        expect(sql(`select count(*) from public.list_org_departure_archives(${q(10)},${q(4)},51,0)`)).toBe("0");
        expect(() => recover(20,4)).toThrow();
        recover(20);
        expect(count("org_departure_archives")).toBe(0);
        expect(sql(`select public.project_access_role(${q(20)},null,${q(10)},${q(3)},'remaining@example.test')`)).toBe("owner");
        expect(count("documents")).toBe(1);
    });

    it("recovers the standalone library dependencies of an archived chat", () => {
        sql(`insert into public.chats(id,org_id,user_id,title) values (${q(40)},${q(10)},${q(2)},'Private chat');
            insert into public.documents(id,org_id,user_id,library_kind) values (${q(60)},${q(10)},${q(2)},'file');
            insert into public.chat_messages(chat_id,role,files) values (${q(40)},'user','[{"document_id":"${uid(60)}"}]');`);
        depart();
        expect(count("org_departure_archives")).toBe(2);
        recover(40);
        expect(count("org_departure_archives")).toBe(0);
        expect(sql(`select user_id from public.documents where id=${q(60)}`)).toBe(uid(3));
    });

    it("expires after 30 days and queues durable file cleanup, but keeps recovered work", () => {
        sql(`insert into public.workflows(id,org_id,user_id,title,type) values (${q(30)},${q(10)},${q(2)},'Private','chat');
            insert into public.documents(id,org_id,user_id,workflow_id,library_kind) values (${q(60)},${q(10)},${q(2)},${q(30)},'workflow_asset');
            insert into public.document_versions(document_id,storage_path) values (${q(60)},'test/expired.pdf');
            insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Kept');`);
        depart();
        recover(20);
        expect(sql(`select public.expire_org_departure_archives(100)`)).toBe("0");
        sql(`update public.org_departure_archives set expires_at=now()-interval '1 second';`);
        expect(() => recover(30)).toThrow();
        expect(sql(`select public.expire_org_departure_archives(100)`)).toBe("1");
        expect(count("workflows")).toBe(0);
        expect(count("projects")).toBe(1);
        expect(count("document_versions")).toBe(0);
        expect(sql(`select count(*) from public.db_jobs where kind='document.cleanup'`)).toBe("1");
        expect(sql(`select public.expire_org_departure_archives(100)`)).toBe("0");
    });

    it("recovers library attachments referenced inside an archived project", () => {
        sql(`insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Private project');
            insert into public.chats(id,org_id,project_id,user_id,title) values (${q(40)},${q(10)},${q(20)},${q(2)},'Project chat');
            insert into public.documents(id,org_id,user_id,library_kind) values (${q(60)},${q(10)},${q(2)},'file');
            insert into public.chat_messages(chat_id,role,files) values (${q(40)},'user','[{"document_id":"${uid(60)}"}]');`);
        depart();
        expect(count("org_departure_archives")).toBe(2);
        recover(20);
        expect(count("org_departure_archives")).toBe(0);
        expect(sql(`select user_id from public.documents where id=${q(60)}`)).toBe(uid(3));
    });

    it("rolls back departures in all organizations when one still needs an owner", () => {
        sql(`insert into public.organizations(id,name,created_by) values (${q(11)},'Last owner org',${q(2)});
            insert into public.org_members(org_id,user_id,role) values (${q(11)},${q(2)},'owner');
            insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Private');`);
        expect(() => sql(`select public.request_account_deletion(${q(2)},'departing@example.test')`)).toThrow();
        expect(sql(`select count(*) from public.org_members where org_id in (${q(10)},${q(11)}) and user_id=${q(2)}`)).toBe("2");
        expect(count("org_departure_archives")).toBe(0);
        expect(count("org_departure_events")).toBe(0);
    });

    it("deletes archives immediately only for an organization owner", () => {
        sql(`insert into public.documents(id,org_id,user_id,library_kind) values (${q(60)},${q(10)},${q(2)},'file');`);
        depart();
        const id=archiveId(60);
        expect(() => sql(`select public.resolve_org_departure_archive(${q(10)},'${id}',${q(4)},null,true)`)).toThrow();
        sql(`select public.resolve_org_departure_archive(${q(10)},'${id}',${q(1)},null,true)`);
        expect(count("documents")).toBe(0);
        expect(count("org_departure_archives")).toBe(0);
    });

    it("account deletion uses the same rules and commits its authentication fence with its job", () => {
        sql(`insert into public.projects(id,org_id,user_id,name,visibility) values
            (${q(20)},${q(10)},${q(2)},'Shared','organization'),(${q(21)},${q(10)},${q(2)},'Private','private');
            select public.request_account_deletion(${q(2)},'departing@example.test');`);
        expect(count("org_departure_archives")).toBe(1);
        expect(sql(`select count(*) from public.org_members where org_id=${q(10)} and user_id=${q(2)}`)).toBe("0");
        expect(sql(`select account_deletion_requested_at is not null from public.user_profiles where user_id=${q(2)}`)).toBe("t");
        expect(sql(`select count(*) from public.db_jobs where kind='account.delete'`)).toBe("1");
        sql(`select public.request_account_deletion(${q(2)},'departing@example.test'); delete from auth.users where id=${q(2)};`);
        expect(count("projects")).toBe(2);
        expect(count("org_departure_archives")).toBe(1);
        expect(count("org_departure_events")).toBe(3);
    });

    it("refuses a last owner even for an empty team, with no partial offboarding or job", () => {
        expect(() => sql(`select public.request_account_deletion(${q(1)},'owner@example.test')`)).toThrow();
        expect(sql(`select count(*) from public.org_members where org_id=${q(10)} and user_id=${q(1)}`)).toBe("1");
        expect(sql(`select account_deletion_requested_at is null from public.user_profiles where user_id=${q(1)}`)).toBe("t");
        expect(sql(`select count(*) from public.db_jobs where kind='account.delete'`)).toBe("0");
        expect(() => depart(99)).toThrow();
        expect(sql(`select count(*) from public.org_members where org_id=${q(10)} and user_id=${q(2)}`)).toBe("1");
    });

    it("does not archive personal work, or let a returning member reclaim archived work", () => {
        sql(`insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Private'),
            (${q(21)},null,${q(2)},'Personal');`);
        depart();
        sql(`insert into public.org_members(org_id,user_id,role) values (${q(10)},${q(2)},'member');`);
        expect(sql(`select public.project_access_role(${q(20)},null,${q(10)},${q(2)},'departing@example.test') is null`)).toBe("t");
        expect(sql(`select user_id from public.projects where id=${q(21)}`)).toBe(uid(2));
        expect(count("org_departure_archives")).toBe(1);
    });

    it("lists archived work for owners with whose it was and what a project holds", () => {
        sql(`insert into public.user_profiles(user_id,display_name,email) values (${q(2)},'Jane Doe','departing@example.test')
                on conflict (user_id) do update set display_name=excluded.display_name,email=excluded.email;
            insert into public.projects(id,org_id,user_id,name,visibility) values (${q(60)},${q(10)},${q(2)},'Private matter','private');
            insert into public.documents(id,org_id,user_id,project_id) values (${q(61)},${q(10)},${q(2)},${q(60)}),(${q(62)},${q(10)},${q(2)},${q(60)});
            insert into public.chats(id,org_id,user_id,project_id,title) values (${q(63)},${q(10)},${q(2)},${q(60)},'In the matter');
            insert into public.chats(id,org_id,user_id,title) values (${q(64)},${q(10)},${q(2)},'Standalone');`);
        depart();
        const list = (actor: number) => JSON.parse(sql(`set role service_role;
            select coalesce(json_agg(x order by kind),'[]') from public.list_org_departure_work(${q(10)},${q(actor)}) x;`)) as Record<string, unknown>[];
        expect(list(4)).toEqual([]);
        expect(list(3)).toEqual([]);
        expect(list(1)).toMatchObject([
            { kind: "chat", item_id: uid(64), title: "Standalone", former_user_id: uid(2), former_display_name: "Jane Doe",
                former_email: "departing@example.test", documents: null, chats: null, tabular_reviews: null },
            { kind: "project", item_id: uid(60), title: "Private matter", documents: 2, chats: 1, tabular_reviews: 0 },
        ]);
        // The account is deleted: the work stays listed, without a name.
        sql(`delete from auth.users where id=${q(2)}`);
        expect(list(1)).toMatchObject([
            { kind: "chat", former_user_id: null, former_display_name: null, former_email: null },
            { kind: "project", former_user_id: null, former_display_name: null, former_email: null, documents: 2 },
        ]);
        sql(`update public.org_departure_archives set expires_at=now()-interval '1 second'`);
        expect(list(1)).toEqual([]);
    });

    it("keeps every lifecycle RPC backend-only", () => {
        for (const name of ['remove_org_member(uuid,uuid,uuid,uuid)','request_account_deletion(uuid,text)',
            'resolve_org_departure_archive(uuid,uuid,uuid,uuid,boolean)','expire_org_departure_archives(integer)']) {
            for (const role of ['anon','authenticated']) {
                expect(sql(`select has_function_privilege('${role}','public.${name}','execute')`)).toBe('f');
            }
        }
    });
});
