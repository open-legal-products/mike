import { describe, expect, it } from "vitest";
import { upsertContentGrant } from "../contentAccess";
import type { Db } from "../supabase";

// What belongs to a team organization is shared inside it only. A chat or
// review started on its own in an organization's workspace can be given to
// other members of that organization, and to nobody else; a personal one can
// still be given to any Mike user.

type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>, failing: string[] = []) {
    const upserts: { table: string; payload: Row }[] = [];
    const queried: string[] = [];
    const from = (table: string) => {
        const filters: [string, unknown][] = [];
        let upserted: Row | null = null;
        const settle = async () => {
            queried.push(table);
            if (failing.includes(table))
                return { data: null, error: { message: `${table} is down` } };
            if (upserted) return { data: { id: "g1", ...upserted }, error: null };
            const row = (tables[table] ?? []).find((candidate) =>
                filters.every(([column, value]) => candidate[column] === value),
            );
            return { data: row ?? null, error: null };
        };
        const builder: Record<string, unknown> = {
            select: () => builder,
            eq: (column: string, value: unknown) => {
                filters.push([column, value]);
                return builder;
            },
            upsert: (payload: Row) => {
                upserted = payload;
                upserts.push({ table, payload });
                return builder;
            },
            single: settle,
            maybeSingle: settle,
        };
        return builder;
    };
    return { db: { from } as unknown as Db, upserts, queried };
}

const TABLES = {
    user_profiles: [
        { user_id: "carol", email: "carol@example.com" },
        { user_id: "erin", email: "erin@example.com" },
    ],
    org_members: [{ org_id: "org-a", user_id: "carol", role: "member" }],
};
const grant = (db: Db, email: string, orgId?: string | null) =>
    upsertContentGrant(db, {
        kind: "chat",
        resourceId: "chat-1",
        email,
        role: "editor",
        createdBy: "alice",
        creatorEmail: "alice@example.com",
        orgId,
    });

describe("sharing a chat or review that belongs to an organization", () => {
    it("gives it to a member of that organization", async () => {
        const fake = makeDb(TABLES);
        await expect(
            grant(fake.db, "Carol@Example.com", "org-a"),
        ).resolves.toMatchObject({ ok: true });
        expect(fake.upserts).toEqual([
            {
                table: "chat_access_grants",
                payload: expect.objectContaining({
                    chat_id: "chat-1",
                    email: "carol@example.com",
                    role: "editor",
                }),
            },
        ]);
    });

    it("refuses a Mike user who is not in the organization, and writes nothing", async () => {
        const fake = makeDb(TABLES);
        await expect(grant(fake.db, "erin@example.com", "org-a")).resolves.toEqual(
            {
                ok: false,
                kind: "validation",
                detail: "erin@example.com is not a member of this organization.",
            },
        );
        expect(fake.upserts).toEqual([]);
    });

    it("does not read a failed membership lookup as 'not a member', or as a member", async () => {
        const fake = makeDb(TABLES, ["org_members"]);
        await expect(
            grant(fake.db, "carol@example.com", "org-a"),
        ).resolves.toMatchObject({ ok: false, kind: "db_error" });
        expect(fake.upserts).toEqual([]);
    });
});

describe("sharing a personal chat or review", () => {
    it.each([null, undefined])(
        "gives it to any Mike user, without asking about organizations (orgId %j)",
        async (orgId) => {
            const fake = makeDb(TABLES);
            await expect(
                grant(fake.db, "erin@example.com", orgId),
            ).resolves.toMatchObject({ ok: true });
            expect(fake.queried).not.toContain("org_members");
            expect(fake.upserts).toHaveLength(1);
        },
    );
});
