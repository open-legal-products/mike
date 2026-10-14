import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Real PostgreSQL semantics in a disposable database. PGlite is an optional
// local alternative, not an application dependency; CI can use the same
// Docker/Postgres container as the departure-retention suite.
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const pgliteModule = process.env.MIKE_TEST_PGLITE_MODULE;
const database = `mike_lifecycle_${process.pid}_${Date.now()}`;
const uid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (n: number) => `'${uid(n)}'`;
let embedded:
    | {
          exec: (s: string) => Promise<unknown>;
          query: (s: string) => Promise<{ rows: Record<string, unknown>[] }>;
          close: () => Promise<void>;
      }
    | undefined;
const dockerSql = (s: string) =>
    execFileSync(
        "docker",
        [
            "exec",
            "-i",
            container!,
            "psql",
            "-U",
            "postgres",
            "-d",
            database,
            "-v",
            "ON_ERROR_STOP=1",
            "-XqAt",
        ],
        { input: s, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
const execute = async (s: string) => {
    if (embedded) await embedded.exec(s);
    else dockerSql(s);
};
const value = async (s: string) =>
    embedded
        ? String(Object.values((await embedded.query(s)).rows[0])[0])
        : dockerSql(s);
const remove = (actor = 1) =>
    execute(`select public.soft_delete_organization(${q(10)},${q(actor)})`);
const restore = (actor = 1) =>
    execute(`select public.restore_organization(${q(10)},${q(actor)})`);

describe.skipIf(!container && !pgliteModule)(
    "organization audit and lifecycle in PostgreSQL",
    () => {
        let created = false;
        beforeAll(async () => {
            if (pgliteModule) {
                const { PGlite } = await import(pgliteModule);
                const { pgcrypto } = await import(
                    new URL("./contrib/pgcrypto.js", pgliteModule).href
                );
                const { pg_trgm } = await import(
                    new URL("./contrib/pg_trgm.js", pgliteModule).href
                );
                embedded = new PGlite({ extensions: { pgcrypto, pg_trgm } });
                await execute(
                    "create role anon; create role authenticated; create role service_role bypassrls;",
                );
            } else {
                execFileSync("docker", [
                    "exec",
                    container!,
                    "createdb",
                    "-U",
                    "postgres",
                    database,
                ]);
                created = true;
            }
            await execute(
                "create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());",
            );
            await execute(readFileSync(resolve("schema.sql"), "utf8"));
            // Replay the complete chain: older migrations must not overwrite
            // the access rules exercised by these regression tests.
            for (let replay = 0; replay < 2; replay++) {
                for (const name of [
                    "20261014_03_organization_audit_lifecycle.sql",
                    "20261014_04_org_private_content_access.sql",
                    "20261014_05_audit_private_content_access.sql",
                    "20261014_06_audit_actor_picker.sql",
                    "20261014_07_org_lifecycle_review_fixes.sql",
                    "20261014_08_paginate_organization_audit.sql",
                ]) await execute(readFileSync(resolve("migrations", name), "utf8"));
            }
        }, 60_000);
        afterAll(async () => {
            if (embedded) await embedded.close();
            if (created)
                execFileSync("docker", [
                    "exec",
                    container!,
                    "dropdb",
                    "-U",
                    "postgres",
                    "--force",
                    database,
                ]);
        });
        beforeEach(async () => {
            await execute(`truncate auth.users,public.organizations,public.audit_events,public.db_jobs cascade;
          insert into auth.users(id,email) values (${q(1)},'owner@example.test'),(${q(2)},'member@example.test'),(${q(3)},'admin@example.test'),(${q(4)},'outsider@example.test');
          insert into public.organizations(id,name,created_by) values (${q(10)},'Synthetic Firm',${q(1)}),(${q(11)},'Other Firm',${q(4)});
          insert into public.org_members(org_id,user_id,role) values (${q(10)},${q(1)},'owner'),(${q(10)},${q(2)},'member'),(${q(10)},${q(3)},'admin'),(${q(11)},${q(4)},'owner');
          insert into public.projects(id,org_id,user_id,name) values (${q(20)},${q(10)},${q(2)},'Private matter');
          insert into public.chats(id,org_id,user_id,title) values (${q(30)},${q(10)},${q(2)},'Private chat');
          insert into public.tabular_reviews(id,org_id,user_id,title) values (${q(40)},${q(10)},${q(2)},'Private review');
          insert into public.documents(id,org_id,user_id,library_kind) values (${q(50)},${q(10)},${q(2)},'file');`);
        });
        it("requires both deletion timestamps and a positive recovery period", async () => {
            await expect(execute(`update public.organizations set deleted_at=now() where id=${q(10)}`)).rejects.toThrow();
            await expect(execute(`update public.organizations set purge_after=now() where id=${q(10)}`)).rejects.toThrow();
            await expect(execute(`update public.organizations set deleted_at=now(),purge_after=now() where id=${q(10)}`)).rejects.toThrow();
        });
        it("retains nonempty organizations and memberships for exactly 30 days, then restores", async () => {
            await remove();
            expect(
                await value(
                    `select extract(epoch from purge_after-deleted_at)::bigint from public.organizations where id=${q(10)}`,
                ),
            ).toBe("2592000");
            expect(
                await value(
                    `select count(*) from public.projects where org_id=${q(10)}`,
                ),
            ).toBe("1");
            expect(
                await value(
                    `select count(*) from public.org_members where org_id=${q(10)}`,
                ),
            ).toBe("3");
            expect(
                await value(
                    `select count(*) from public.active_org_members where org_id=${q(10)}`,
                ),
            ).toBe("0");
            await restore();
            expect(
                await value(
                    `select count(*) from public.active_org_members where org_id=${q(10)}`,
                ),
            ).toBe("3");
            expect(
                await value(
                    `select string_agg(action,',' order by created_at) from public.audit_events where org_id=${q(10)}`,
                ),
            ).toBe("org.deleted,org.restored");
        });
        it("refuses members, admins, outsiders and personal organizations", async () => {
            for (const actor of [2, 3, 4])
                await expect(remove(actor)).rejects.toThrow();
            await remove();
            for (const actor of [2, 3, 4])
                await expect(restore(actor)).rejects.toThrow();
            await expect(
                execute(
                    `select public.soft_delete_organization((select id from public.organizations where personal_user_id=${q(1)}),${q(1)})`,
                ),
            ).rejects.toThrow();
        });
        it("blocks creator, grant and unscoped SQL access while deleted", async () => {
            await remove();
            for (const expr of [
                `public.project_access_role(${q(20)},${q(2)},${q(10)},'${uid(2)}','member@example.test')`,
                `public.chat_access_role(${q(30)},${q(2)},null,${q(10)},'${uid(2)}','member@example.test')`,
                `public.review_access_role(${q(40)},${q(2)},null,${q(10)},'${uid(2)}','member@example.test')`,
            ])
                expect(await value(`select (${expr}) is null`)).toMatch(
                    /^(true|t)$/,
                );
            await expect(
                execute(
                    `update public.chats set org_id=null where id=${q(30)}`,
                ),
            ).rejects.toThrow();
            expect(
                await value(
                    `select count(*) from public.ensure_user_memory_file(${q(2)},${q(10)})`,
                ),
            ).toBe("0");
            await expect(
                execute(
                    `insert into public.chats(org_id,user_id,title) values (${q(10)},${q(2)},'Late create')`,
                ),
            ).rejects.toThrow();
            await expect(
                execute(
                    `insert into public.org_members(org_id,user_id,role) values (${q(10)},${q(4)},'member')`,
                ),
            ).rejects.toThrow();
        });
        it("does not extend the recovery deadline on repeated deletion", async () => {
            await remove();
            const deadline = await value(
                `select purge_after::text from public.organizations where id=${q(10)}`,
            );
            await remove();
            expect(
                await value(
                    `select purge_after::text from public.organizations where id=${q(10)}`,
                ),
            ).toBe(deadline);
            expect(
                await value(
                    "select count(*) from public.audit_events where action='org.deleted'",
                ),
            ).toBe("1");
        });
        it("rejects expired restore even before a worker sweeps, and purges only expired orgs", async () => {
            await remove();
            await execute(
                `update public.organizations set deleted_at=now()-interval '31 days',purge_after=now() where id=${q(10)}`,
            );
            await expect(restore()).rejects.toThrow();
            expect(
                await value("select public.purge_expired_organizations(10)"),
            ).toBe("1");
            expect(
                await value(
                    `select count(*) from public.organizations where id=${q(11)}`,
                ),
            ).toBe("1");
            expect(
                await value(
                    `select count(*) from public.projects where org_id=${q(10)}`,
                ),
            ).toBe("0");
            expect(
                await value(
                    "select count(*) from public.audit_events where action='org.purged'",
                ),
            ).toBe("1");
            expect(
                await value("select public.purge_expired_organizations(10)"),
            ).toBe("0");
        });
        it("enqueues durable document storage cleanup only at permanent purge", async () => {
            await execute(
                `insert into public.document_versions(document_id,version_number,storage_path,filename) values (${q(50)},1,'test/source.docx','Synthetic.docx');`,
            );
            await remove();
            expect(
                await value(
                    "select count(*) from public.db_jobs where kind='document.cleanup'",
                ),
            ).toBe("0");
            await execute(
                `update public.organizations set deleted_at=now()-interval '31 days',purge_after=now() where id=${q(10)}; select public.purge_expired_organizations(10);`,
            );
            expect(
                Number(
                    await value(
                        "select count(*) from public.db_jobs where kind='document.cleanup'",
                    ),
                ),
            ).toBeGreaterThan(0);
        });
        it("preserves attribution after a resource is deleted and backfills only known scopes", async () => {
            await execute(`insert into public.audit_events(user_id,action,project_id,title) values (${q(2)},'chat.message',${q(20)},'Sensitive prompt');
            insert into public.audit_events(user_id,action) values (${q(2)},'export.account');`);
            expect(
                await value(
                    "select org_id from public.audit_events where action='chat.message'",
                ),
            ).toBe(uid(10));
            expect(
                await value(
                    "select org_id is null from public.audit_events where action='export.account'",
                ),
            ).toMatch(/^(true|t)$/);
            await execute(`delete from public.projects where id=${q(20)}`);
            expect(
                await value(
                    "select org_id from public.audit_events where action='chat.message'",
                ),
            ).toBe(uid(10));
        });
        it("redacts private content before organization search and denies foreign/member audit access", async () => {
            await execute(`insert into public.audit_events(user_id,action,project_id,title,detail) values (${q(2)},'chat.message',${q(20)},'Secret merger','{"prompt":"Secret merger"}');
            insert into public.audit_events(user_id,org_id,action,title) values (${q(1)},${q(10)},'org.created','Synthetic Firm'),(${q(4)},${q(11)},'org.created','Other Firm');`);
            const feed = (actor: number) =>
                `public.organization_audit_events(${q(10)},${q(actor)},'actor@example.test')`;
            for (const actor of [3]) {
                expect(await value(`select count(*) from ${feed(actor)}`)).toBe(
                    "2",
                );
                expect(
                    await value(
                        `select count(*) from ${feed(actor)} where title ilike '%Secret%'`,
                    ),
                ).toBe("0");
                expect(
                    await value(
                        `select detail is null and project_id is null from ${feed(actor)} where action='chat.message'`,
                    ),
                ).toMatch(/^(true|t)$/);
            }
            // Owners can discover private content, but must explicitly open
            // it before receiving read-only resource access.
            expect(await value(`select count(*) from ${feed(1)} where title ilike '%Secret%'`)).toBe("1");
            expect(await value(`select public.org_private_access_role(${q(10)},'project',${q(20)},'${uid(1)}') is null`)).toMatch(/^(true|t)$/);
            for (const actor of [2, 4])
                expect(await value(`select count(*) from ${feed(actor)}`)).toBe(
                    "0",
                );
        });
        it("does not unarchive previously departed content when the org is restored", async () => {
            await execute(
                `update public.projects set archived_at=now() where id=${q(20)}`,
            );
            await remove();
            await restore();
            expect(
                await value(
                    `select archived_at is not null from public.projects where id=${q(20)}`,
                ),
            ).toMatch(/^(true|t)$/);
        });
        it("archives departing work while deleted so restoration cannot expose ownerless items", async () => {
            await execute(`
              insert into public.workflows(id,org_id,user_id,title,type) values (${q(60)},${q(10)},${q(2)},'Private workflow','assistant');
              insert into public.projects(id,org_id,user_id,name,visibility) values (${q(21)},${q(10)},${q(2)},'Shared matter','organization');
            `);
            await remove();
            await execute(`select public.prepare_account_org_departures(${q(2)}); delete from auth.users where id=${q(2)};`);
            expect(await value(`select count(*) from public.org_departure_archives where org_id=${q(10)}`)).toBe("6");
            expect(await value(`select count(*) from public.org_departure_events where org_id=${q(10)} and action='item.archived'`)).toBe("6");
            expect(await value(`select count(*) from public.org_departure_events where org_id=${q(10)} and action='item.transferred'`)).toBe("0");
            await restore();
            for (const [table, id] of [["projects",20],["projects",21],["workflows",60],["chats",30],["tabular_reviews",40],["documents",50]] as const) {
                expect(await value(`select archived_at is not null and user_id is null from public.${table} where id=${q(id)}`)).toMatch(/^(true|t)$/);
            }
            expect(await value(`select public.project_access_role(${q(20)},null,${q(10)},'${uid(1)}','owner@example.test') is null`)).toMatch(/^(true|t)$/);
            expect(await value(`select public.workflow_access_role(${q(60)},null,${q(10)},'${uid(1)}','owner@example.test') is null`)).toMatch(/^(true|t)$/);
        });
        it("permits account deletion while its organization awaits purge and keeps audit records", async () => {
            await remove();
            await execute(
                `select public.prepare_account_org_departures(${q(2)}); delete from auth.users where id=${q(2)};`,
            );
            expect(
                await value(
                    `select count(*) from public.projects where org_id=${q(10)}`,
                ),
            ).toBe("1");
            await execute(`delete from auth.users where id=${q(1)}`);
            expect(
                await value(
                    "select count(*) from public.audit_events where action='org.deleted' and user_id is null",
                ),
            ).toBe("1");
        });
    },
);
