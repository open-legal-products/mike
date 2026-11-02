import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    isPersonalOrg,
    isPersonalOrgRow,
    listPersonalOrgIds,
} from "../personalOrgs";
import { scriptedDb } from "../../__tests__/helpers/scriptedDb";

describe("isPersonalOrgRow", () => {
    it.each([
        [{ kind: "personal" }, true],
        [{ kind: "team" }, false],
        // A row read before the column existed.
        [{ id: "o1", name: "Acme" }, false],
        [null, false],
        [undefined, false],
    ])("%j → %s", (row, expected) => {
        expect(isPersonalOrgRow(row)).toBe(expected);
    });
});

describe("isPersonalOrg", () => {
    it("asks about that one organization", async () => {
        const fake = scriptedDb([
            { table: "organizations", data: { kind: "personal" } },
        ]);
        await expect(isPersonalOrg(fake.db, "o1")).resolves.toBe(true);
        expect(fake.calls[0].filters).toEqual([["eq", "id", "o1"]]);
        fake.done();
    });

    it("is false for a team organization, and for an id that names nothing", async () => {
        const fake = scriptedDb([
            { table: "organizations", data: { kind: "team" } },
            { table: "organizations", data: null },
        ]);
        await expect(isPersonalOrg(fake.db, "o1")).resolves.toBe(false);
        await expect(isPersonalOrg(fake.db, "gone")).resolves.toBe(false);
        fake.done();
    });

    it.each([null, undefined, ""])(
        "does not touch the database for %j",
        async (orgId) => {
            const fake = scriptedDb([]);
            await expect(isPersonalOrg(fake.db, orgId)).resolves.toBe(false);
            fake.done();
        },
    );

    it.each(["42703", "PGRST204"])(
        "reads a database without the column (%s) as having no personal organizations",
        async (code) => {
            const fake = scriptedDb([
                {
                    table: "organizations",
                    error: { code, message: "column does not exist" },
                },
            ]);
            await expect(isPersonalOrg(fake.db, "o1")).resolves.toBe(false);
            fake.done();
        },
    );

    it("throws on any other failure, instead of letting the request through", async () => {
        const fake = scriptedDb([
            { table: "organizations", error: { message: "connection reset" } },
        ]);
        await expect(isPersonalOrg(fake.db, "o1")).rejects.toThrow(
            "Failed to read the organization's kind",
        );
        fake.done();
    });
});

describe("listPersonalOrgIds", () => {
    it("finds the organization that is that person's own", async () => {
        const fake = scriptedDb([
            { table: "organizations", data: [{ id: "mine" }] },
        ]);
        await expect(listPersonalOrgIds(fake.db, "u1")).resolves.toEqual(
            new Set(["mine"]),
        );
        expect(fake.calls[0].filters).toEqual([
            ["eq", "personal_user_id", "u1"],
        ]);
        fake.done();
    });

    it("is empty before the column exists, and throws on any other failure", async () => {
        const fake = scriptedDb([
            {
                table: "organizations",
                error: { code: "42703", message: "column does not exist" },
            },
            { table: "organizations", error: { message: "connection reset" } },
        ]);
        await expect(listPersonalOrgIds(fake.db, "u1")).resolves.toEqual(
            new Set(),
        );
        await expect(listPersonalOrgIds(fake.db, "u1")).rejects.toThrow(
            "Failed to read the personal organization",
        );
        fake.done();
    });
});

// ---------------------------------------------------------------------------
// Static checks on the SQL, in the manner of orgSqlPredicates.test.ts: what
// the rules below guard is exercised properly only against a live Postgres.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const migration = readFileSync(
    resolve(ROOT, "migrations/20261012_06_personal_organizations.sql"),
    "utf8",
);
const schema = readFileSync(resolve(ROOT, "schema.sql"), "utf8");

/** `create or replace function public.<name>(…) … $$;`, as written. */
function functionSource(sql: string, name: string): string {
    const start = sql.indexOf(`create or replace function public.${name}(`);
    expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
    const end = sql.indexOf("\n$$;", start);
    expect(end).toBeGreaterThan(start);
    return sql.slice(start, end + "\n$$;".length);
}

describe("personal organizations in SQL", () => {
    it.each([
        "ensure_personal_organization",
        "org_members_guard_personal",
        "org_invitations_guard_personal",
        "handle_new_user",
    ])(
        "a fresh install defines %s exactly as the migration does",
        (name) => {
            expect(functionSource(schema, name)).toBe(
                functionSource(migration, name),
            );
        },
    );

    it("never lets creating the personal organization block sign-up, or undo the profile", () => {
        // Two blocks, each with its own handler: an exception in the second
        // rolls back only the second.
        const body = functionSource(schema, "handle_new_user");
        const profile = body.indexOf("insert into public.user_profiles");
        const firstHandler = body.indexOf("exception when others then");
        const ensure = body.indexOf(
            "perform public.ensure_personal_organization(new.id)",
        );
        const secondHandler = body.indexOf(
            "exception when others then",
            ensure,
        );
        expect(profile).toBeGreaterThan(0);
        expect(firstHandler).toBeGreaterThan(profile);
        expect(ensure).toBeGreaterThan(firstHandler);
        expect(secondHandler).toBeGreaterThan(ensure);
    });

    it("keeps creating one out of reach of signed-in and anonymous callers", () => {
        for (const sql of [migration, schema]) {
            expect(sql).toMatch(
                /revoke all on function public\.ensure_personal_organization\(uuid\)\s+from public, anon, authenticated;/,
            );
        }
    });

    it("ties the kind to having an owner, one organization per person", () => {
        for (const sql of [migration, schema]) {
            expect(sql).toContain(
                "check ((kind = 'personal') = (personal_user_id is not null))",
            );
            expect(sql).toMatch(
                /create unique index if not exists organizations_personal_user_key\s+on public\.organizations\(personal_user_id\)\s+where personal_user_id is not null;/,
            );
        }
    });
});
