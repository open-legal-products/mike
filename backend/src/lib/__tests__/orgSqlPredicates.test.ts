import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static checks on the org RPCs' SQL.
//
// The visibility predicates in the consolidated organization-access migration
// are the SQL twins of lib/access.ts,
// and the mistakes below are invisible in review because the wrong version
// and the right version differ by one word. Exercising them
// properly needs a live Postgres (npm run test:stack), which does not run in
// `npm test` — so these read the shipped SQL and assert the shape directly.
// A grep-shaped test is a poor substitute for executing the query, and a very
// good substitute for nothing.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const SOURCES = {
    "migrations/20260904_01_organization_access.sql": readFileSync(
        resolve(ROOT, "migrations/20260904_01_organization_access.sql"),
        "utf8",
    ),
    "schema.sql": readFileSync(resolve(ROOT, "schema.sql"), "utf8"),
};

describe.each(Object.entries(SOURCES))("%s", (_name, sql) => {
    it("compares p_user_email case-insensitively everywhere", () => {
        // Emails are stored lowercase (all access-grant tables carry a
        // lowercase CHECK), and every predicate lower()s the
        // caller's address before comparing — except two arms that did not,
        // so a caller whose account email is "B@Example.com" was invisible to
        // exactly those two branches while every sibling branch admitted
        // them. List and detail disagreeing about the same review is the bug
        // class this PR exists to close.
        //
        // Rather than enumerate the legitimate uses (declarations,
        // pass-throughs, coalesce guards), this looks only for the two shapes
        // that actually compare a stored value against the raw parameter.
        const offenders = sql
            .split("\n")
            .map((line, index) => [index + 1, line.trim()] as const)
            .filter(
                ([, line]) =>
                    /@>\s*jsonb_build_array\(\s*p_user_email\s*\)/.test(line) ||
                    /(=|<>|like|ilike)\s*p_user_email\b/i.test(line),
            );
        expect(offenders).toEqual([]);
    });

    it("derives workflow capabilities from the effective resource role", () => {
        const orgArms = [
            ...sql.matchAll(/org_shared as \(([\s\S]*?)\n  \),/g),
        ].map(([, body]) => body);
        // Only the arms that project an allow_edit column: the filter-options
        // RPC has an org arm too, and it returns facets, not capabilities.
        const editArms = orgArms.filter((arm) => /as allow_edit/.test(arm));
        expect(editArms.length).toBeGreaterThan(0);
        for (const arm of editArms) {
            expect(arm).toContain("in ('owner', 'editor')) as allow_edit");
            expect(arm).toContain("= 'owner') as is_owner");
        }
    });

    it("never offers NULL as an owner-filter option", () => {
        // `on delete set null` means a project can outlive its creator with
        // user_id = NULL. Emitting that as a dropdown option produced an entry
        // whose value is null — and selecting it made the guard
        // `p_owner_user_id is null or p.user_id::text = p_owner_user_id` true
        // for every row, so the filter silently disabled itself rather than
        // narrowing anything.
        const cte = sql.slice(
            sql.indexOf("distinct_owners as ("),
            sql.indexOf("owner_options as ("),
        );
        expect(cte).toContain("distinct_owners as (");
        expect(cte).toMatch(/where\s+vp\.user_id\s+is\s+not\s+null/);
    });

    it("binds overrides to the resource's current organization", () => {
        for (const join of [
            "o.org_id = p_org_id",
        ]) {
            expect(sql.match(new RegExp(join.replace(".", "\\."), "g"))?.length)
                .toBeGreaterThanOrEqual(2);
        }
        expect(sql).toContain("org_members_cleanup_access_overrides");
        expect(sql).toContain("org_id is distinct from new.org_id");
    });
});

it("the final schema and access-grant migration contain no jsonb share predicate", () => {
    const latest = SOURCES["migrations/20260904_01_organization_access.sql"];
    for (const sql of [SOURCES["schema.sql"], latest]) {
        expect(sql).not.toMatch(/shared_with\s+@>/);
        expect(sql).toContain("tabular_review_access_grants");
        expect(sql).toContain("chat_access_grants");
        expect(sql).toMatch(/g\.email\s*=\s*lower\(p_user_email\)/);
    }
});

it("keeps organization-wide scope exclusive to projects and workflows", () => {
    // A chat or review can belong to an organization on its own (see the
    // standalone tests below), but it is never opened to the whole
    // organization: it has no visibility and no per-member overrides, only
    // its author and direct grants.
    const schema = SOURCES["schema.sql"];
    const migration = SOURCES["migrations/20260904_01_organization_access.sql"];

    expect(schema).not.toContain("create table if not exists public.chat_org_access_overrides");
    expect(schema).not.toContain(
        "create table if not exists public.tabular_review_org_access_overrides",
    );
    expect(migration).not.toContain("public.chat_org_access_overrides");
    expect(migration).not.toContain("public.tabular_review_org_access_overrides");
});

// A chat or review started on its own in an organization's workspace belongs
// to that organization and is private to its author. Both role functions
// decide that through one helper; ensureSharedRowAccess (lib/access.ts) is
// its TypeScript twin.
describe("standalone chats and reviews in an organization", () => {
    const schema = SOURCES["schema.sql"];
    const migration = readFileSync(
        resolve(ROOT, "migrations/20261012_07_standalone_org_content.sql"),
        "utf8",
    );
    const functionSource = (sql: string, name: string) => {
        const start = sql.indexOf(`create or replace function public.${name}(`);
        expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
        const end = sql.indexOf("\n$$;", start);
        return sql.slice(start, end);
    };

    it("no longer requires a project for a chat or review to carry an organization", () => {
        expect(schema).not.toContain("chats_org_requires_project");
        expect(schema).not.toContain("tabular_reviews_org_requires_project");
        expect(migration).toContain(
            "drop constraint if exists chats_org_requires_project",
        );
        expect(migration).toContain(
            "drop constraint if exists tabular_reviews_org_requires_project",
        );
    });

    // Match each function to the latest migration that defines it. The
    // retention migration adds archive visibility checks to chat/review access.
    const handover = readFileSync(
        resolve(ROOT, "migrations/20261013_01_member_handover.sql"),
        "utf8",
    );

    it("a fresh install defines org_is_team exactly as the migration does", () => {
        expect(functionSource(schema, "org_is_team")).toBe(
            functionSource(migration, "org_is_team"),
        );
    });

    const retention = readFileSync(
        resolve(ROOT, "migrations/20261013_05_org_departure_retention.sql"),
        "utf8",
    );

    it.each([
        ["standalone_org_access_role", handover],
        ["chat_access_role", retention],
        ["review_access_role", retention],
    ])(
        "a fresh install defines %s exactly as its latest migration does",
        (name, latest) => {
            expect(functionSource(schema, name)).toBe(
                functionSource(latest, name),
            );
        },
    );

    it.each([
        "org_members_departure_items",
        "org_member_sole_owned_items",
        "assign_org_member_items",
        "cleanup_removed_org_member_overrides",
        "org_member_private_standalone",
    ])("a fresh install defines %s exactly as the retention migration does", (name) => {
        expect(functionSource(schema, name)).toBe(functionSource(retention, name));
    });

    it("asks membership first: nobody outside the organization reaches it, its author included", () => {
        const body = functionSource(schema, "standalone_org_access_role");
        const membership = body.indexOf("when not exists (");
        const author = body.indexOf(
            "when p_creator_id::text = p_user_id then 'owner'",
        );
        const grant = body.indexOf("else p_grant_role");
        expect(membership).toBeGreaterThan(0);
        expect(author).toBeGreaterThan(membership);
        expect(grant).toBeGreaterThan(author);
    });

    it("gives the organization's owners no arm of their own: nobody takes one over", () => {
        const body = functionSource(schema, "standalone_org_access_role");
        expect(body).not.toMatch(/role = 'owner'/);
        expect(body).not.toContain("p_has_member_owner");
        // The five-argument form that carried the take-over is dropped.
        expect(handover).toContain(
            "drop function if exists public.standalone_org_access_role(uuid, uuid, text, text, boolean);",
        );
    });

    it("inspects private ownership before membership grants cascade away", () => {
        expect(schema).toContain("create trigger org_members_cleanup_access_overrides before delete");
        const body = functionSource(schema, "cleanup_removed_org_member_overrides");
        expect(body.indexOf("public.org_members_departure_items")).toBeLessThan(
            body.indexOf("delete from public.project_org_access_overrides"),
        );
        expect(body).toContain("if public.org_is_team(old.org_id) then");
        expect(body).toContain("for update");
    });

    it("transfers public or shared work, archives unshared work and hides private titles", () => {
        const body = functionSource(schema, "org_members_departure_items");
        expect(body.match(/item.visibility='organization' or exists/g)).toHaveLength(2);
        expect(body.match(/g.role in \('owner','editor','viewer'\)/g)).toHaveLength(4);
        expect(body.match(/then 'transfer' else 'archive' end/g)).toHaveLength(5);
        expect(body.match(/case when item.visibility='organization' then item.\w+ else null::text end/g)).toHaveLength(2);
        expect(functionSource(schema, "org_member_sole_owned_items")).toContain("where disposition='transfer'");
    });

    it("keeps co-owned work and archives standalone documents instead of deleting them immediately", () => {
        const body = functionSource(schema, "org_members_departure_items");
        expect(body.match(/and not exists \(select 1 from public.org_members m/g)).toHaveLength(4);
        expect(body.match(/g.role='owner' and not \(holder.user_id = any\(p_user_ids\)\)/g)).toHaveLength(4);
        expect(body).toContain("d.project_id is null and d.workflow_id is null and d.archived_at is null");
        const cleanup = functionSource(schema, "cleanup_removed_org_member_overrides");
        expect(cleanup).toContain("insert into public.org_departure_archives");
        expect(cleanup).toContain("archived_at=now(),user_id=null");
        for (const table of ["projects", "workflows", "chats", "tabular_reviews", "documents"])
            expect(cleanup).not.toContain(`delete from public.${table} where`);
    });

    it.each(["chat_access_role", "review_access_role"])(
        "%s tries the project, then a team organization, then the personal rule",
        (name) => {
            const body = functionSource(schema, name);
            const project = body.indexOf("when p_project_id is not null then");
            const team = body.indexOf(
                "when public.org_is_team(p_org_id) then public.standalone_org_access_role(",
            );
            const creator = body.search(/when p_\w+_user_id::text = p_user_id then 'owner'/);
            expect(project).toBeGreaterThan(0);
            expect(team).toBeGreaterThan(project);
            expect(creator).toBeGreaterThan(team);
        },
    );

    it("treats a personal organization as personal, not as a team", () => {
        expect(functionSource(schema, "org_is_team")).toContain(
            "where o.id = p_org_id and o.kind = 'team'",
        );
    });
});

// Organization content is private by default. The two role functions are the
// SQL twins of resolveOrgContentRole (lib/access.ts), and every list RPC
// decides visibility through them.
describe("private-by-default organization access in SQL", () => {
    const migration = readFileSync(
        resolve(ROOT, "migrations/20261011_03_org_private_by_default.sql"),
        "utf8",
    );
    const roleFunction = (sql: string, name: string) => {
        const start = sql.indexOf(`create or replace function public.${name}(`);
        expect(start).toBeGreaterThan(-1);
        return sql.slice(start, sql.indexOf("\n$$;\n", start));
    };

    describe.each([
        ["schema.sql", SOURCES["schema.sql"]],
        ["the migration", migration],
    ])("%s", (_name, sql) => {
        it("constrains visibility, and keeps personal items private", () => {
            for (const table of ["projects", "workflows"]) {
                expect(sql).toContain(`${table}_visibility_check`);
                expect(sql).toContain(`${table}_visibility_scope_check`);
            }
            expect(sql).toContain("check (visibility in ('private', 'organization'))");
            expect(sql).toContain("check (visibility = 'private' or org_id is not null)");
        });

        it("labels scope from visibility and grants, never from membership alone", () => {
            // An organization's private project used to be labelled
            // 'organization' simply for having an org_id.
            expect(sql).not.toMatch(/when vp\.org_id is not null then 'organization'/);
            expect(sql).not.toMatch(/when w\.org_id is not null then 'organization'/);
            expect(sql).not.toContain("'organization'::text as access_scope");
            expect(sql).toContain(
                "public.project_access_scope(vp.id, vp.org_id, vp.visibility) as access_scope",
            );
            expect(sql).toContain(
                "public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope",
            );
            // A denial is not sharing.
            expect(roleFunction(sql, "project_access_scope")).toContain(
                "o.role <> 'deny'",
            );
            expect(roleFunction(sql, "workflow_access_scope")).toContain(
                "o.role <> 'deny'",
            );
        });
    });

    it("makes existing organization content public, once", () => {
        // Nobody loses access on upgrade...
        expect(migration).toMatch(
            /update public\.workflows\s+set visibility = 'organization'\s+where org_id is not null/,
        );
        expect(migration).toMatch(
            /update public\.projects\s+set visibility =\s+case when org_id is not null then 'organization' else 'private' end/,
        );
        // ...and a second run cannot re-publish what has since been made
        // private: the backfill sits inside the branch that adds the column.
        const guard = migration.indexOf("and column_name = 'visibility'");
        const addColumn = migration.indexOf("add column visibility");
        const backfill = migration.indexOf("update public.projects");
        const endOfBranch = migration.indexOf("end if;");
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(addColumn);
        expect(addColumn).toBeLessThan(backfill);
        expect(backfill).toBeLessThan(endOfBranch);
    });
});

// An organization's owners do not own its members' private work (20261012_04).
// The role functions first shipped with "an owner owns everything"; the
// schema and the later migration carry the rule that replaced it.
describe("an organization owner's standing on content in SQL", () => {
    const first = readFileSync(
        resolve(ROOT, "migrations/20261011_03_org_private_by_default.sql"),
        "utf8",
    );
    const current = readFileSync(
        resolve(ROOT, "migrations/20261012_04_org_owner_private_access.sql"),
        "utf8",
    );
    const body = (sql: string, name: string) => {
        const start = sql.indexOf(`create or replace function public.${name}(`);
        expect(start).toBeGreaterThan(-1);
        return sql.slice(start, sql.indexOf("\n$$;\n", start));
    };
    const inOrder = (text: string, fragments: string[]) => {
        const order = fragments.map((fragment) => text.indexOf(fragment));
        expect(order.every((index) => index > -1)).toBe(true);
        expect([...order].sort((x, y) => x - y)).toEqual(order);
    };

    it.each(["project_access_role", "workflow_access_role"])(
        "%s, as first shipped, gave an owner everything",
        (name) => {
            // History: a migration that has run is not edited.
            expect(body(first, name)).toContain(
                "when m.role = 'owner' then 'owner'",
            );
        },
    );

    describe.each([
        ["schema.sql", SOURCES["schema.sql"]],
        ["the migration", current],
    ])("%s", (_name, sql) => {
        it.each([
            ["project_access_role", "public.project_is_ownerless("],
            ["workflow_access_role", "public.workflow_is_ownerless("],
        ])(
            "%s resolves creator, owner of a public or ownerless item, override, then public, then nothing",
            (name, ownerless) => {
                const text = body(sql, name);
                // The order matters: an override must be read before the
                // public default, or a denial on a public item is ignored;
                // and the owner's branch must be conditional, or private
                // stops being private.
                inOrder(text, [
                    "= p_user_id then 'owner'",
                    "when m.role = 'owner' and (",
                    ") = 'organization'",
                    ownerless,
                    ") then 'owner'",
                    "when o.role = 'deny' then null",
                    "when o.role in ('owner', 'editor', 'viewer') then o.role",
                    ") = 'organization' then 'editor'",
                    "else null",
                ]);
                // No unconditional standing for owners, none at all for
                // admins, and no "everyone is an editor" fallback.
                expect(text).not.toContain("when m.role = 'owner' then 'owner'");
                expect(text).not.toMatch(/m\.role in \('owner', 'admin'\)/);
                expect(text).not.toMatch(/m\.role = 'admin'/);
                expect(text).not.toMatch(/else 'editor'/);
            },
        );

        it.each(["project_is_ownerless", "workflow_is_ownerless"])(
            "%s means the creator is gone and no member is an Owner",
            (name) => {
                const text = body(sql, name);
                inOrder(text, [
                    "p_org_id is not null",
                    "from public.org_members creator",
                    "o.role = 'owner'",
                ]);
                // Both are absences: neither a member creator nor a member
                // Owner may exist.
                expect(text.split("not exists (").length - 1).toBe(2);
            },
        );

        it("exempts an organization owner from overrides on a public item only", () => {
            const guard = body(sql, "validate_org_access_override");
            expect(guard).toContain(
                "if member_role = 'owner' and resource_visibility = 'organization' then",
            );
            expect(guard).toContain("Organization owners always own a public item");
            expect(guard).not.toContain(
                "Organization owners always have owner access",
            );
            expect(guard).not.toMatch(/member_role in \('owner', 'admin'\)/);
        });

        it("keeps a promoted owner's roles on private items", () => {
            const cleanup = body(sql, "cleanup_org_admin_access_overrides");
            // A wall must survive a promotion to admin...
            expect(cleanup).toContain("if new.role = 'owner' then");
            expect(cleanup).not.toContain("if new.role in ('owner', 'admin') then");
            // ...and a promotion to owner clears only what the office now
            // covers anyway.
            expect(cleanup).toContain("p.visibility = 'organization'");
            expect(cleanup).toContain("w.visibility = 'organization'");
        });

        it("closes the ownerless functions to client roles", () => {
            for (const signature of [
                "project_is_ownerless(uuid, uuid, uuid)",
                "workflow_is_ownerless(uuid, uuid, uuid)",
                "org_item_is_ownerless(text, uuid)",
                "ownerless_org_item_ids(uuid[])",
            ]) {
                expect(sql).toContain(
                    `revoke all on function public.${signature}\n  from public, anon, authenticated;`,
                );
                expect(sql).toContain(
                    `grant execute on function public.${signature}\n  to service_role;`,
                );
            }
        });
    });

    it("never makes a departure wait on a hand-over", () => {
        // The guard that refused to remove a member who alone owned
        // something only worked while owners owned everything.
        expect(current).toContain(
            "drop trigger if exists org_members_resource_owner_guard on public.org_members;",
        );
        expect(current).toContain(
            "drop function if exists public.org_member_protect_resource_ownership();",
        );
        expect(SOURCES["schema.sql"]).not.toContain(
            "org_member_protect_resource_ownership",
        );
        expect(SOURCES["schema.sql"]).not.toContain(
            "org_members_resource_owner_guard",
        );
    });
});

// The Public and Private tabs. Each list RPC that takes a scope must offer
// both, on the paged list AND its select-all sibling, or "select all" picks
// rows the visible list does not show.
describe("public and not-public list scopes in SQL", () => {
    const migration = readFileSync(
        resolve(ROOT, "migrations/20261012_01_public_private_list_scopes.sql"),
        "utf8",
    );
    describe.each([
        ["schema.sql", SOURCES["schema.sql"]],
        ["the migration", migration],
    ])("%s", (_name, sql) => {
        it("filters projects by the scope the lists label, on the list and its ids", () => {
            const scope = "public.project_access_scope(p.id, p.org_id, p.visibility)";
            expect(
                sql.split(`p_scope = 'public'\n          and ${scope} = 'organization'`)
                    .length - 1,
            ).toBe(1);
            expect(
                sql.split(`p_scope = 'public'\n        and ${scope} = 'organization'`)
                    .length - 1,
            ).toBe(1);
            // Private is everything that is not public, shared or not.
            expect(sql).toContain(
                `p_scope = 'nonpublic'\n          and ${scope} <> 'organization'`,
            );
            expect(sql).toContain(
                `p_scope = 'nonpublic'\n        and ${scope} <> 'organization'`,
            );
        });

        it("filters workflows the same way, on the list and its ids", () => {
            expect(
                sql.split(
                    "or (p_scope = 'public' and vw.access_scope = 'organization')",
                ).length - 1,
            ).toBe(2);
            expect(
                sql.split(
                    "or (p_scope = 'nonpublic' and vw.access_scope <> 'organization')",
                ).length - 1,
            ).toBe(2);
        });
    });
});

it("keeps at least one owner per organization in SQL", () => {
    const schema = SOURCES["schema.sql"];
    const migration = readFileSync(
        resolve(ROOT, "migrations/20261011_01_org_owner_role.sql"),
        "utf8",
    );
    for (const sql of [schema, migration]) {
        expect(sql).toContain("check (role in ('owner', 'admin', 'member'))");
        expect(sql).toContain("org_members_last_owner_guard");
        expect(sql).toContain("An organization must keep at least one owner");
    }
    // The guard the owner one replaces must not survive on either path: left
    // in place it refuses to move a sole admin off 'admin', which is the
    // backfill, and afterwards it would demand an admin no rule requires.
    expect(schema).not.toContain("org_members_protect_last_admin");
    expect(migration).toContain(
        "drop trigger if exists org_members_last_admin_guard on public.org_members",
    );
    expect(migration).toContain(
        "drop function if exists public.org_members_protect_last_admin()",
    );
    // The new guard is installed before the backfill runs.
    expect(migration.indexOf("create trigger org_members_last_owner_guard"))
        .toBeLessThan(migration.indexOf("update public.org_members m"));
    // Invitations never carry ownership.
    expect(schema).toMatch(
        /create table if not exists public\.org_invitations[\s\S]*?check \(role in \('admin', 'member'\)\)/,
    );
});

it("backfills owners only into organizations that have none", () => {
    const migration = readFileSync(
        resolve(ROOT, "migrations/20261011_01_org_owner_role.sql"),
        "utf8",
    );
    const backfill = migration.slice(
        migration.indexOf("update public.org_members m"),
        migration.indexOf("-- 4. Content access"),
    );
    expect(backfill).toContain("set role = 'owner'");
    expect(backfill).toContain("where m.role = 'admin'");
    // Without this guard a second run promotes every admin an owner has
    // appointed since the first.
    expect(backfill).toMatch(/and not exists \([\s\S]*existing_owner\.role = 'owner'/);
});
