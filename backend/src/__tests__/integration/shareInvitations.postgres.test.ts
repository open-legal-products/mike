import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// claim_share_invitations in real PostgreSQL, in a disposable database:
// set MIKE_TEST_POSTGRES_CONTAINER to a running Postgres container (the
// same switch as the other *.postgres suites).
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const database = `audit_tmp_pg_${randomBytes(6).toString("hex")}`;
const uid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (n: number) => `'${uid(n)}'`;
const sql = (s: string) =>
    execFileSync(
        "docker",
        ["exec", "-i", container!, "psql", "-U", "postgres", "-d", database,
            "-v", "ON_ERROR_STOP=1", "-XqAt"],
        { input: s, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

const SHARER = 1;
const RECIPIENT = 2;
const OWNER_BY_GRANT = 3;
const PROJECT = 20;

const claim = (user: number) =>
    sql(`select coalesce(string_agg(resource_kind || ':' || outcome, ',' order by resource_kind), '')
         from public.claim_share_invitations(${q(user)})`);
const projectGrant = () =>
    sql(`select coalesce(string_agg(role, ','), '') from public.project_access_grants
         where project_id = ${q(PROJECT)} and email = 'new@outside.test'`);
/** A pending project share to new@outside.test, with any column overridden. */
const invite = (column = "", value = "") =>
    sql(`insert into public.share_invitations (project_id, email, role, invited_by${column ? `, ${column}` : ""})
         values (${q(PROJECT)}, 'new@outside.test', 'editor', ${q(SHARER)}${column ? `, ${value}` : ""})`);
const signUp = (confirmed: boolean) =>
    sql(`insert into auth.users (id, email, email_confirmed_at)
         values (${q(RECIPIENT)}, 'New@Outside.test', ${confirmed ? "now()" : "null"})`);

describe.skipIf(!container)("pending shares claimed in PostgreSQL", () => {
    let created = false;
    beforeAll(() => {
        execFileSync("docker", ["exec", container!, "createdb", "-U", "postgres", database]);
        created = true;
        sql("create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());");
        sql(readFileSync(resolve("schema.sql"), "utf8"));
        // The migration must apply on top of the finished schema, twice.
        const migration = readFileSync(resolve("migrations", "20261115_02_share_invitations.sql"), "utf8");
        sql(migration);
        sql(migration);
    }, 120_000);
    afterAll(() => {
        if (created)
            execFileSync("docker", ["exec", container!, "dropdb", "-U", "postgres", "--force", database]);
    });
    beforeEach(() => {
        sql(`truncate auth.users, public.organizations cascade;
          insert into auth.users (id, email, email_confirmed_at) values
            (${q(SHARER)}, 'sharer@firm.test', now()),
            (${q(OWNER_BY_GRANT)}, 'co-owner@firm.test', now());
          insert into public.projects (id, user_id, name) values (${q(PROJECT)}, ${q(SHARER)}, 'Matter');`);
    });

    it("attaches a pending share once the address is confirmed, not before", () => {
        invite();
        signUp(false);
        expect(claim(RECIPIENT)).toBe("");
        expect(projectGrant()).toBe("");

        sql(`update auth.users set email_confirmed_at = now() where id = ${q(RECIPIENT)}`);
        expect(claim(RECIPIENT)).toBe("project:accepted");
        expect(projectGrant()).toBe("editor");
        // Claimed once: a second sign-in finds nothing left to claim.
        expect(claim(RECIPIENT)).toBe("");
    });

    it("never attaches a cancelled or expired pending share", () => {
        invite("status", "'cancelled'");
        signUp(true);
        expect(claim(RECIPIENT)).toBe("");
        sql("delete from public.share_invitations");
        invite("expires_at", "now() - interval '1 minute'");
        expect(claim(RECIPIENT)).toBe("");
        expect(projectGrant()).toBe("");
    });

    it("re-checks at claim that the sharer may still share", () => {
        // A co-owner by grant shares, then loses Owner before the claim.
        sql(`insert into public.project_access_grants (project_id, email, role, created_by)
             values (${q(PROJECT)}, 'co-owner@firm.test', 'owner', ${q(SHARER)})`);
        sql(`insert into public.share_invitations (project_id, email, role, invited_by)
             values (${q(PROJECT)}, 'new@outside.test', 'owner', ${q(OWNER_BY_GRANT)})`);
        sql(`update public.project_access_grants set role = 'viewer' where email = 'co-owner@firm.test'`);
        signUp(true);
        expect(claim(RECIPIENT)).toBe("project:refused");
        expect(projectGrant()).toBe("");
        expect(sql(`select status from public.share_invitations`)).toBe("cancelled");
    });

    it("refuses a share whose project has since moved into an organization", () => {
        invite();
        sql(`insert into public.organizations (id, name, created_by) values (${q(10)}, 'Firm', ${q(SHARER)});
             insert into public.org_members (org_id, user_id, role) values (${q(10)}, ${q(SHARER)}, 'owner');
             update public.projects set org_id = ${q(10)} where id = ${q(PROJECT)};`);
        signUp(true);
        expect(claim(RECIPIENT)).toBe("project:refused");
        expect(projectGrant()).toBe("");
    });

    it("writes the grant into each resource's own table", () => {
        sql(`insert into public.chats (id, user_id, title) values (${q(30)}, ${q(SHARER)}, 'Chat');
             insert into public.tabular_reviews (id, user_id, title) values (${q(40)}, ${q(SHARER)}, 'Review');
             insert into public.workflows (id, user_id, title, type) values (${q(50)}, ${q(SHARER)}, 'Flow', 'chat');
             insert into public.playbooks (id, user_id, name, content_json) values (${q(60)}, ${q(SHARER)}, 'Book', '{}');
             insert into public.share_invitations (chat_id, email, role, invited_by) values (${q(30)}, 'new@outside.test', 'viewer', ${q(SHARER)});
             insert into public.share_invitations (tabular_review_id, email, role, invited_by) values (${q(40)}, 'new@outside.test', 'viewer', ${q(SHARER)});
             insert into public.share_invitations (workflow_id, email, role, invited_by) values (${q(50)}, 'new@outside.test', 'viewer', ${q(SHARER)});
             insert into public.share_invitations (playbook_id, email, role, invited_by) values (${q(60)}, 'new@outside.test', 'viewer', ${q(SHARER)});`);
        signUp(true);
        expect(claim(RECIPIENT)).toBe(
            "chat:accepted,playbook:accepted,tabular_review:accepted,workflow:accepted",
        );
        expect(sql(`select
            (select count(*) from public.chat_access_grants where email = 'new@outside.test')::text ||
            (select count(*) from public.tabular_review_access_grants where email = 'new@outside.test') ||
            (select count(*) from public.workflow_shares where shared_with_email = 'new@outside.test') ||
            (select count(*) from public.playbook_shares where shared_with_email = 'new@outside.test')`)).toBe("1111");
    });
});
