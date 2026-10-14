import { describe, expect, it, vi } from "vitest";
import {
    canManageOrgRole,
    checkProjectAccess,
    checkWorkflowAccess,
    creatorScopedAllowed,
    ensureChatAccess,
    ensureDocAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    isOrgAdmin,
    isOrgOwner,
    listAccessibleProjectIds,
    parseContentVisibility,
    resolveContentOrgId,
    resolveOrgContentRole,
    resolveStandaloneOrgId,
    strongerOrgRole,
} from "../access";
import { ownerlessRpcResult } from "../../__tests__/helpers/ownerlessRpc";

type Row = Record<string, unknown>;

function makeDb(
    tables: Record<string, Row[]>,
    options: {
        selectErrors?: Record<string, string>;
        maxRows?: number;
        pageError?: (table: string, from: number) => string | undefined;
    } = {},
) {
    return {
        // Whether an organization's item has an Owner left is the database's
        // to say; answered here from the same tables.
        rpc: async (name: string, args?: Record<string, unknown>) =>
            (name === "list_org_private_content_access" ? { data: [], error: null } : null) ??
            ownerlessRpcResult(tables, name, args) ?? {
                data: null,
                error: { message: `unexpected rpc ${name}` },
            },
        from(table: string) {
            let rows: Row[] = (tables[table] ?? []).map(row => ({ archived_at: null, ...row }));
            let pageFrom = 0;
            const failure = options.selectErrors?.[table]
                ? { message: options.selectErrors[table] }
                : null;
            const query = {
                select: () => query,
                order: () => query,
                limit: (n: number) => {
                    rows = rows.slice(0, n);
                    return query;
                },
                // Paged reads: `.range(from, to)` is inclusive at both ends,
                // and returning a short page is what stops the caller's loop.
                range: (from: number, to: number) => {
                    pageFrom = from;
                    rows = rows.slice(from, to + 1);
                    return query;
                },
                eq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                is: (column: string, value: unknown) => {
                    rows = rows.filter((row) => (column === "organizations.deleted_at"
                        ? tables.organizations?.find((org) => org.id === row.org_id)?.deleted_at ?? null
                        : row[column]) === value);
                    return query;
                },
                neq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] !== value);
                    return query;
                },
                in: (column: string, values: unknown[]) => {
                    rows = rows.filter((row) => values.includes(row[column]));
                    return query;
                },
                filter: (column: string, operator: string, value: string) => {
                    if (operator !== "cs") return query;
                    const expected = JSON.parse(value) as string[];
                    rows = rows.filter((row) => {
                        const actual = row[column];
                        return (
                            Array.isArray(actual) &&
                            expected.every((item) => actual.includes(item))
                        );
                    });
                    return query;
                },
                single: async () =>
                    failure
                        ? { data: null, error: failure }
                        : { data: rows[0] ?? null, error: null },
                maybeSingle: async () =>
                    failure
                        ? { data: null, error: failure }
                        : { data: rows[0] ?? null, error: null },
                then: (
                    resolve: (value: {
                        data: Row[] | null;
                        error: { message: string } | null;
                    }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) =>
                    Promise.resolve(
                        failure || options.pageError?.(table, pageFrom)
                            ? {
                                  data: null,
                                  error: failure ?? {
                                      message: options.pageError!(
                                          table,
                                          pageFrom,
                                      )!,
                                  },
                              }
                            : {
                                  data: rows.slice(
                                      0,
                                      options.maxRows ?? rows.length,
                                  ),
                                  error: null,
                              },
                    ).then(resolve, reject),
            };
            return query;
        },
    } as any;
}

describe("access helpers", () => {
    it("denies archived containers to former creators and organization owners", async () => {
        const db = makeDb({
            organizations: [{ id: "org", kind: "team" }],
            org_members: [{ org_id: "org", user_id: "owner", role: "owner" }],
            projects: [{ id: "p", org_id: "org", user_id: "owner", visibility: "organization", archived_at: "2026-10-13" }],
            workflows: [{ id: "w", org_id: "org", user_id: "owner", visibility: "organization", archived_at: "2026-10-13" }],
        });
        expect(await checkProjectAccess("p", "owner", "owner@example.test", db)).toEqual({ ok: false });
        expect(await checkWorkflowAccess("w", "owner", "owner@example.test", db)).toEqual({ ok: false });
        expect(await listAccessibleProjectIds("owner", "owner@example.test", db)).toEqual([]);
    });

    const db = makeDb({
        projects: [
            { id: "own-project", user_id: "owner", org_id: null },
            { id: "granted-project", user_id: "other-owner", org_id: null },
            { id: "private-project", user_id: "other-owner", org_id: null },
        ],
        project_access_grants: [
            {
                project_id: "granted-project",
                email: "reviewer@example.com",
                role: "editor",
            },
        ],
        documents: [
            { id: "own-doc", user_id: "owner", project_id: null },
            {
                id: "granted-doc",
                user_id: "other-owner",
                project_id: "granted-project",
            },
            {
                id: "private-doc",
                user_id: "other-owner",
                project_id: "private-project",
            },
        ],
        workflow_shares: [
            {
                workflow_id: "shared-workflow",
                shared_with_email: "reviewer@example.com",
                role: "viewer",
            },
            {
                workflow_id: "editable-workflow",
                shared_with_email: "reviewer@example.com",
                role: "editor",
            },
        ],
        workflows: [
            {
                id: "shared-workflow",
                user_id: "other-owner",
                org_id: null,
            },
            {
                id: "editable-workflow",
                user_id: "other-owner",
                org_id: null,
            },
        ],
        tabular_review_access_grants: [
            {
                tabular_review_id: "review-direct",
                email: "reviewer@example.com",
                role: "editor",
            },
        ],
    });

    it("makes the project's creator an owner", async () => {
        const access = await checkProjectAccess(
            "own-project",
            "owner",
            "owner@example.com",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            isCreator: true,
            projectRole: "owner",
        });
    });

    it("gives a direct grantee exactly the role they were granted", async () => {
        const access = await checkProjectAccess(
            "granted-project",
            "reviewer",
            "reviewer@example.com",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "editor",
        });
    });

    it("matches grant emails case-insensitively", async () => {
        const access = await checkProjectAccess(
            "granted-project",
            "reviewer",
            "  Reviewer@Example.com ",
            db,
        );
        expect(access.ok).toBe(true);
    });

    it("denies a project the caller has no route into", async () => {
        await expect(
            checkProjectAccess(
                "private-project",
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    // A document in no project or workflow is its uploader's alone — in
    // Personal, and in an organization's workspace, where it also needs them
    // to still be a member. The organization's owners have no standing on it.
    it("keeps a standalone document in an organization to its uploader, while they are a member", async () => {
        const orgDb = makeDb({
            organizations: [
                { id: "org-a", kind: "team" },
                { id: "mine", kind: "personal", personal_user_id: "alice" },
            ],
            org_members: [
                { org_id: "org-a", user_id: "alice", role: "member" },
                { org_id: "org-a", user_id: "dave", role: "owner" },
                { org_id: "org-a", user_id: "ivan", role: "admin" },
                { org_id: "mine", user_id: "alice", role: "owner" },
            ],
        });
        const doc = (uploader: string, orgId: string | null) => ({
            user_id: uploader,
            project_id: null,
            org_id: orgId,
        });
        const open = (document: ReturnType<typeof doc>, user: string) =>
            ensureDocAccess(document, user, `${user}@example.com`, orgDb);

        await expect(open(doc("alice", "org-a"), "alice")).resolves.toEqual({
            ok: true,
            isCreator: true,
            orgRole: "member",
            projectRole: "owner",
        });
        // Not the organization's owner, nor an admin, nor a colleague.
        for (const other of ["dave", "ivan", "carol"])
            await expect(open(doc("alice", "org-a"), other)).resolves.toEqual({
                ok: false,
            });
        // Not its uploader either, once they have left.
        await expect(open(doc("frank", "org-a"), "frank")).resolves.toEqual({
            ok: false,
        });
        // ... and nobody takes it over.
        await expect(open(doc("frank", "org-a"), "dave")).resolves.toEqual({
            ok: false,
        });
        // Personal, with or without a personal organization behind it.
        for (const orgId of [null, "mine"])
            await expect(open(doc("alice", orgId), "alice")).resolves.toEqual({
                ok: true,
                isCreator: true,
                orgRole: null,
                projectRole: "owner",
            });
    });

    it("allows document creators and readers of the containing project", async () => {
        await expect(
            ensureDocAccess(
                { user_id: "owner", project_id: null },
                "owner",
                "owner@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "owner" });
        await expect(
            ensureDocAccess(
                { user_id: "other-owner", project_id: "granted-project" },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
        await expect(
            ensureDocAccess(
                { user_id: "other-owner", project_id: "private-project" },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("applies workflow share edit permissions to workflow assets", async () => {
        await expect(
            ensureDocAccess(
                {
                    user_id: "other-owner",
                    project_id: null,
                    workflow_id: "shared-workflow",
                },
                "reviewer",
                " REVIEWER@EXAMPLE.COM ",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
        await expect(
            ensureDocAccess(
                {
                    user_id: "other-owner",
                    project_id: null,
                    workflow_id: "editable-workflow",
                },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
    });

    it("allows direct review sharing without project access", async () => {
        await expect(
            ensureReviewAccess(
                {
                    id: "review-direct",
                    user_id: "other-owner",
                    project_id: null,
                },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "editor" });
    });

    it("does not grant organization access to a standalone review", async () => {
        const orgDb = makeDb({
            org_members: [
                { org_id: "org-1", user_id: "reviewer", role: "admin" },
            ],
            tabular_review_access_grants: [],
        });
        await expect(
            ensureReviewAccess(
                {
                    id: "legacy-org-review",
                    user_id: "other-owner",
                    project_id: null,
                    org_id: "org-1",
                },
                "reviewer",
                "reviewer@example.com",
                orgDb,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("lists projects reached by creation and by grant", async () => {
        await expect(
            listAccessibleProjectIds("owner", "owner@example.com", db),
        ).resolves.toEqual(["own-project"]);
        await expect(
            listAccessibleProjectIds("reviewer", "reviewer@example.com", db),
        ).resolves.toEqual(["granted-project"]);
    });

    it("filters user-supplied document IDs to accessible documents only", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["own-doc", "granted-doc", "private-doc"],
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual(["granted-doc"]);
    });
});

// ---------------------------------------------------------------------------
// Organization inheritance
// ---------------------------------------------------------------------------

describe("org role inheritance", () => {
    // The rule every read path shares. Organization content is private by
    // default; these are all the ways somebody comes to hold a role on it.
    describe("resolveOrgContentRole", () => {
        const resolve = (input: {
            isCreator?: boolean;
            orgRole: "owner" | "admin" | "member";
            override?: "owner" | "editor" | "viewer" | "deny" | null;
            visibility?: unknown;
            ownerless?: boolean;
        }) =>
            resolveOrgContentRole({
                isCreator: false,
                override: null,
                visibility: "private",
                ownerless: false,
                ...input,
            });

        // Private is private: running the organization, or owning it,
        // does not make a member's matter yours to read.
        it.each(["owner", "admin", "member"] as const)(
            "gives an organization %s nothing on somebody else's private item",
            (orgRole) => {
                expect(resolve({ orgRole })).toBeNull();
            },
        );

        it("gives the creator Owner, whatever else is set", () => {
            for (const visibility of ["private", "organization"]) {
                for (const override of [null, "viewer", "deny"] as const) {
                    expect(
                        resolve({
                            orgRole: "member",
                            isCreator: true,
                            visibility,
                            override,
                        }),
                    ).toBe("owner");
                }
            }
        });

        it("gives an organization owner Owner on a public item, whatever else is set", () => {
            for (const override of [null, "viewer", "deny"] as const) {
                expect(
                    resolve({
                        orgRole: "owner",
                        visibility: "organization",
                        override,
                    }),
                ).toBe("owner");
            }
        });

        it("gives an organization owner exactly the role a private item was shared with them at", () => {
            for (const override of ["owner", "editor", "viewer"] as const)
                expect(resolve({ orgRole: "owner", override })).toBe(override);
            expect(resolve({ orgRole: "owner", override: "deny" })).toBeNull();
        });

        it("hands a private item with no Owner left to the organization's owners, and to nobody else", () => {
            // Its creator has left and nobody else was made an Owner.
            for (const override of [null, "viewer", "deny"] as const)
                expect(
                    resolve({ orgRole: "owner", ownerless: true, override }),
                ).toBe("owner");
            expect(resolve({ orgRole: "admin", ownerless: true })).toBeNull();
            expect(resolve({ orgRole: "member", ownerless: true })).toBeNull();
            // A member it was shared with keeps what they were given.
            expect(
                resolve({ orgRole: "member", ownerless: true, override: "viewer" }),
            ).toBe("viewer");
        });

        it.each(["owner", "editor", "viewer"] as const)(
            "gives a member it was shared with the %s role they were given",
            (override) => {
                expect(resolve({ orgRole: "member", override })).toBe(override);
                // An admin is a member as far as content goes.
                expect(resolve({ orgRole: "admin", override })).toBe(override);
            },
        );

        it("gives every member Editor on a public item", () => {
            expect(
                resolve({ orgRole: "member", visibility: "organization" }),
            ).toBe("editor");
            expect(
                resolve({ orgRole: "admin", visibility: "organization" }),
            ).toBe("editor");
        });

        it("lets an individual grant stand on a public item, in either direction", () => {
            expect(
                resolve({
                    orgRole: "member",
                    visibility: "organization",
                    override: "viewer",
                }),
            ).toBe("viewer");
            expect(
                resolve({
                    orgRole: "member",
                    visibility: "organization",
                    override: "owner",
                }),
            ).toBe("owner");
        });

        it("walls a denied member off a public item, an admin included", () => {
            for (const orgRole of ["member", "admin"] as const) {
                expect(
                    resolve({
                        orgRole,
                        visibility: "organization",
                        override: "deny",
                    }),
                ).toBeNull();
            }
        });

        it("treats anything but 'organization' as private", () => {
            // Fail closed: a value this code does not know must not open an
            // item to everybody.
            for (const visibility of [undefined, null, "", "public", "all", 1]) {
                expect(resolve({ orgRole: "member", visibility })).toBeNull();
            }
        });
    });

    describe("parseContentVisibility", () => {
        it("leaves visibility alone when none is sent", () => {
            expect(parseContentVisibility(undefined, "org-1")).toEqual({
                ok: true,
                visibility: undefined,
            });
            expect(parseContentVisibility(null, null)).toEqual({
                ok: true,
                visibility: undefined,
            });
        });

        it("accepts either setting for an organization's item", () => {
            expect(parseContentVisibility("organization", "org-1")).toEqual({
                ok: true,
                visibility: "organization",
            });
            expect(parseContentVisibility("private", "org-1")).toEqual({
                ok: true,
                visibility: "private",
            });
        });

        it("refuses to make a personal item public", () => {
            // There is no "everyone" for a personal item to be opened to.
            expect(parseContentVisibility("organization", null)).toMatchObject({
                ok: false,
            });
            expect(parseContentVisibility("private", null)).toEqual({
                ok: true,
                visibility: "private",
            });
        });

        it.each(["public", "everyone", "", 1, true, {}])(
            "refuses %j",
            (value) => {
                expect(parseContentVisibility(value, "org-1")).toMatchObject({
                    ok: false,
                });
            },
        );
    });

    it("treats an owner as able to do everything an admin can", () => {
        expect(isOrgAdmin("owner")).toBe(true);
        expect(isOrgAdmin("admin")).toBe(true);
        expect(isOrgAdmin("member")).toBe(false);
        expect(isOrgAdmin(null)).toBe(false);
        expect(isOrgOwner("owner")).toBe(true);
        expect(isOrgOwner("admin")).toBe(false);
    });

    it("lets owners manage every role and everyone else only those below", () => {
        const roles = ["owner", "admin", "member"] as const;
        const allowed = (actor: (typeof roles)[number]) =>
            roles.filter((role) => canManageOrgRole(actor, role));
        expect(allowed("owner")).toEqual(["owner", "admin", "member"]);
        // Not "admin": an admin who could manage admins could appoint one,
        // or remove the peer who was about to object.
        expect(allowed("admin")).toEqual(["member"]);
        expect(allowed("member")).toEqual([]);
        expect(canManageOrgRole(null, "member")).toBe(false);
    });

    it("picks the stronger of two organization roles", () => {
        expect(strongerOrgRole("member", "admin")).toBe("admin");
        expect(strongerOrgRole("owner", "admin")).toBe("owner");
        expect(strongerOrgRole("admin", "admin")).toBe("admin");
    });

    // org-project is private, org-public is open to the whole organization.
    // boss owns the organization, partner administers it, staffer is a
    // plain member; none of them created either project.
    const db = makeDb({
        projects: [
            {
                id: "org-project",
                user_id: "founder",
                org_id: "org-1",
                visibility: "private",
            },
            {
                id: "org-public",
                user_id: "founder",
                org_id: "org-1",
                visibility: "organization",
            },
            { id: "other-org-project", user_id: "stranger", org_id: "org-2" },
            { id: "personal-project", user_id: "founder", org_id: null },
        ],
        org_members: [
            { org_id: "org-1", user_id: "founder", role: "admin" },
            { org_id: "org-1", user_id: "boss", role: "owner" },
            { org_id: "org-1", user_id: "partner", role: "admin" },
            { org_id: "org-1", user_id: "staffer", role: "member" },
            { org_id: "org-2", user_id: "outsider", role: "admin" },
        ],
        project_access_grants: [
            // A viewer grant handed to people who already have stronger
            // standing through the org — it must not demote them.
            { project_id: "org-project", email: "boss@firm.example", role: "viewer" },
            {
                project_id: "org-project",
                email: "staffer@firm.example",
                role: "viewer",
            },
            // An outside individual: no org membership at all.
            {
                project_id: "org-project",
                email: "counsel@outside.example",
                role: "owner",
            },
            {
                project_id: "org-public",
                email: "staffer@firm.example",
                role: "viewer",
            },
            {
                project_id: "org-public",
                email: "counsel@outside.example",
                role: "owner",
            },
        ],
        documents: [],
    });

    it("gives an organization owner nothing on a member's private project", async () => {
        // The founder is still in the organization, so the project has its
        // Owner. Owning the organization is not a key to it.
        await expect(
            checkProjectAccess("org-project", "boss", "nobody@firm.example", db),
        ).resolves.toEqual({ ok: false });
    });

    it("gives an organization owner Owner on a public project", async () => {
        await expect(
            checkProjectAccess("org-public", "boss", "nobody@firm.example", db),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            orgRole: "owner",
            projectRole: "owner",
        });
    });

    describe("a private project whose creator has left the organization", () => {
        const orphaned = (extra: Record<string, Row[]> = {}) =>
            makeDb({
                projects: [
                    {
                        id: "left-behind",
                        user_id: "departed",
                        org_id: "org-1",
                        visibility: "private",
                    },
                ],
                org_members: [
                    { org_id: "org-1", user_id: "boss", role: "owner" },
                    { org_id: "org-1", user_id: "partner", role: "admin" },
                    { org_id: "org-1", user_id: "staffer", role: "member" },
                ],
                project_org_access_overrides: [],
                ...extra,
            });

        it("passes to the organization's owners, and to nobody else", async () => {
            const db = orphaned();
            await expect(
                checkProjectAccess("left-behind", "boss", null, db),
            ).resolves.toMatchObject({ ok: true, projectRole: "owner" });
            for (const userId of ["partner", "staffer"])
                await expect(
                    checkProjectAccess("left-behind", userId, null, db),
                ).resolves.toEqual({ ok: false });
        });

        it("stays out of the owners' hands while a member is still an Owner of it", async () => {
            const db = orphaned({
                project_org_access_overrides: [
                    {
                        project_id: "left-behind",
                        org_id: "org-1",
                        user_id: "staffer",
                        role: "owner",
                    },
                ],
            });
            await expect(
                checkProjectAccess("left-behind", "boss", null, db),
            ).resolves.toEqual({ ok: false });
            await expect(
                checkProjectAccess("left-behind", "staffer", null, db),
            ).resolves.toMatchObject({ ok: true, projectRole: "owner" });
        });

        it("is not handed over on the strength of an unanswered question", async () => {
            // Fail closed: if the database cannot say, the owner is a member
            // like any other.
            const db = orphaned();
            db.rpc = async () => ({
                data: null,
                error: { message: "function does not exist" },
            });
            await expect(
                checkProjectAccess("left-behind", "boss", null, db),
            ).resolves.toEqual({ ok: false });
        });
    });

    it("gives an organization owner the role a private project was shared with them at", async () => {
        const shared = makeDb({
            projects: [
                {
                    id: "org-project",
                    user_id: "founder",
                    org_id: "org-1",
                    visibility: "private",
                },
            ],
            org_members: [
                { org_id: "org-1", user_id: "founder", role: "member" },
                { org_id: "org-1", user_id: "boss", role: "owner" },
            ],
            project_org_access_overrides: [
                {
                    project_id: "org-project",
                    org_id: "org-1",
                    user_id: "boss",
                    role: "viewer",
                },
            ],
        });
        await expect(
            checkProjectAccess("org-project", "boss", null, shared),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
    });

    it.each(["partner", "staffer"])(
        "gives %s, who is in the organization, nothing on a private project",
        async (userId) => {
            // Membership is no longer access. An admin runs the organization;
            // that does not make every matter in it theirs to read.
            await expect(
                checkProjectAccess(
                    "org-project",
                    userId,
                    "nobody@firm.example",
                    db,
                ),
            ).resolves.toEqual({ ok: false });
        },
    );

    it.each([
        ["partner", "admin"],
        ["staffer", "member"],
    ])("gives %s Editor on a public project", async (userId, orgRole) => {
        await expect(
            checkProjectAccess("org-public", userId, "nobody@firm.example", db),
        ).resolves.toMatchObject({
            ok: true,
            orgRole,
            projectRole: "editor",
        });
    });

    it("keeps an organization Owner as Owner while applying overrides to everyone else", async () => {
        const overrideDb = makeDb({
            projects: [
                {
                    id: "overridden",
                    user_id: "founder",
                    org_id: "org-1",
                    visibility: "organization",
                },
            ],
            org_members: [
                { org_id: "org-1", user_id: "founder", role: "admin" },
                { org_id: "org-1", user_id: "admin-editor", role: "admin" },
                { org_id: "org-1", user_id: "owner-denied", role: "owner" },
                { org_id: "org-1", user_id: "member-viewer", role: "member" },
                { org_id: "org-1", user_id: "member-denied", role: "member" },
            ],
            project_org_access_overrides: [
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "admin-editor",
                    role: "editor",
                },
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "owner-denied",
                    role: "deny",
                },
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "member-viewer",
                    role: "viewer",
                },
                {
                    project_id: "overridden",
                    org_id: "org-1",
                    user_id: "member-denied",
                    role: "deny",
                },
            ],
            workflows: [
                {
                    id: "workflow-overridden",
                    user_id: "founder",
                    org_id: "org-1",
                    visibility: "organization",
                },
            ],
            workflow_org_access_overrides: [
                {
                    workflow_id: "workflow-overridden",
                    org_id: "org-1",
                    user_id: "admin-editor",
                    role: "deny",
                },
                {
                    workflow_id: "workflow-overridden",
                    org_id: "org-1",
                    user_id: "owner-denied",
                    role: "deny",
                },
            ],
        });
        // A stale deny row must not bind an organization owner on either
        // resource kind: nothing else can recover a matter everyone else has
        // been walled off from.
        await expect(
            checkProjectAccess("overridden", "owner-denied", null, overrideDb),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "owner",
            projectRole: "owner",
        });
        await expect(
            checkWorkflowAccess(
                "workflow-overridden",
                "owner-denied",
                null,
                overrideDb,
            ),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "owner",
            projectRole: "owner",
        });
        // An admin is shared with, and walled off, like any other member.
        await expect(
            checkProjectAccess("overridden", "admin-editor", null, overrideDb),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "admin",
            projectRole: "editor",
        });
        await expect(
            checkWorkflowAccess(
                "workflow-overridden",
                "admin-editor",
                null,
                overrideDb,
            ),
        ).resolves.toEqual({ ok: false });
        await expect(
            checkProjectAccess("overridden", "member-viewer", null, overrideDb),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
        await expect(
            checkProjectAccess("overridden", "member-denied", null, overrideDb),
        ).resolves.toEqual({ ok: false });
    });

    it("ignores direct email grants for organization projects", async () => {
        // An organization's project is shared through its member overrides.
        // A leftover email grant neither demotes, admits nor promotes.
        //
        // Org Owner + viewer direct grant on a PRIVATE project: no access.
        await expect(
            checkProjectAccess("org-project", "boss", "boss@firm.example", db),
        ).resolves.toEqual({ ok: false });
        // ... and on a public one stays Owner, not the grant's Viewer.
        await expect(
            checkProjectAccess("org-public", "boss", "boss@firm.example", db),
        ).resolves.toMatchObject({ projectRole: "owner" });
        // Org Member + viewer direct grant on a PRIVATE project: no access.
        await expect(
            checkProjectAccess(
                "org-project",
                "staffer",
                "staffer@firm.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
        // Org Member + viewer direct grant on a public project stays Editor.
        await expect(
            checkProjectAccess(
                "org-public",
                "staffer",
                "staffer@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "editor" });
    });

    it("does not let a direct grant promote an organization member", async () => {
        await expect(
            checkProjectAccess(
                "org-public",
                "staffer",
                "counsel@outside.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "editor" });
    });

    it("denies an outsider despite a legacy direct grant", async () => {
        const access = await checkProjectAccess(
            "org-project",
            "outside-counsel",
            "counsel@outside.example",
            db,
        );
        expect(access).toEqual({ ok: false });
    });

    it("isolates users across orgs (cross-tenant denial)", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "outsider",
                "outsider@elsewhere.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("keeps personal projects out of every org's reach", async () => {
        await expect(
            checkProjectAccess(
                "personal-project",
                "boss",
                "boss@firm.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("inherits only the project verdict when a document belongs to a project", async () => {
        const crossDb = makeDb({
            projects: [
                {
                    id: "p",
                    user_id: "someone",
                    org_id: "org-2",
                    visibility: "organization",
                },
            ],
            org_members: [
                { org_id: "org-1", user_id: "u", role: "admin" },
                { org_id: "org-2", user_id: "u", role: "member" },
            ],
            project_access_grants: [],
        });
        await expect(
            ensureDocAccess(
                { user_id: "someone", project_id: "p", org_id: "org-1" },
                "u",
                "u@firm.example",
                crossDb,
            ),
        ).resolves.toMatchObject({ projectRole: "editor", orgRole: "member" });
    });

    it("inherits the project Owner role for a review", async () => {
        await expect(
            ensureReviewAccess(
                {
                    id: "admin-review",
                    user_id: "someone-else",
                    project_id: "org-public",
                },
                "boss",
                "boss@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "owner" });
    });

    it("keeps an organization owner out of a review in a member's private project", async () => {
        await expect(
            ensureReviewAccess(
                {
                    id: "admin-review",
                    user_id: "someone-else",
                    project_id: "org-project",
                },
                "boss",
                "boss@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ ok: false });
    });
});

// ---------------------------------------------------------------------------
// Personal content carries no organization
// ---------------------------------------------------------------------------

describe("content org resolution", () => {
    const db = makeDb({
        projects: [
            { id: "org-project", user_id: "u", org_id: "org-1" },
            { id: "personal-project", user_id: "u", org_id: null },
        ],
    });

    it("inherits the project's organization for content inside it", async () => {
        await expect(
            resolveContentOrgId(db, { projectId: "org-project" }),
        ).resolves.toEqual({ ok: true, orgId: "org-1" });
    });

    it("leaves content with no organization when there is none to inherit", async () => {
        // No hidden personal org to fall back on: org_id IS NULL *is* personal.
        await expect(
            resolveContentOrgId(db, { projectId: "personal-project" }),
        ).resolves.toEqual({ ok: true, orgId: null });
        await expect(
            resolveContentOrgId(db, { projectId: null }),
        ).resolves.toEqual({ ok: true, orgId: null });
    });

    it("refuses to answer when the lookup fails, instead of guessing personal", async () => {
        // ok:false and orgId:null must be distinguishable: null is the
        // encoding of personal content, and personal content is what account
        // deletion destroys. A failed read that presented as null filed a
        // firm's upload as its uploader's private property.
        const failing = makeDb(
            { projects: [] },
            { selectErrors: { projects: "connection reset" } },
        );
        await expect(
            resolveContentOrgId(failing, { projectId: "org-project" }),
        ).resolves.toMatchObject({ ok: false });
    });
});

describe("creator-scoped operations", () => {
    // A handful of operations — replacing or deleting one version of a
    // document, moving a review between projects — belong to whoever made the
    // row rather than to a tier. Account deletion now blanks user_id instead
    // of destroying an organization's content, so "only the creator" has to
    // answer the case where the creator no longer exists.
    it("lets the creator act", () => {
        expect(
            creatorScopedAllowed({ isCreator: true, projectRole: "viewer" }, "u1"),
        ).toBe(true);
    });

    it("still refuses an Owner while the creator exists", () => {
        // The rule is about authorship, not rank: an Owner does not get to
        // reach into a colleague's versions just for outranking them.
        expect(
            creatorScopedAllowed({ isCreator: false, projectRole: "owner" }, "u2"),
        ).toBe(false);
    });

    it("hands a creator-less row to the container's Owners", () => {
        // Otherwise deleting the account that made the row would strand it
        // inside a project the organization is supposed to control, with
        // nobody able to act on it ever again.
        expect(
            creatorScopedAllowed({ isCreator: false, projectRole: "owner" }, null),
        ).toBe(true);
    });

    it("does not hand a creator-less row to Editors or Viewers", () => {
        for (const role of ["editor", "viewer"] as const) {
            expect(
                creatorScopedAllowed({ isCreator: false, projectRole: role }, null),
            ).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// Chats and reviews share the same role-aware direct-grant model. These cases
// pin each exclusive scope and project inheritance.
// ---------------------------------------------------------------------------
// A chat or review started on its own in an organization's workspace belongs
// to that organization and is private to its author: nobody takes it over,
// the organization's owners included. The SQL twin is
// public.standalone_org_access_role.
describe("a standalone chat or review in an organization", () => {
    // org-a is a firm: dave owns it, alice and carol are members, ivan an
    // admin. frank wrote things there and has since left. erin was never in
    // it. `mine` is alice's own personal organization.
    const db = makeDb({
        organizations: [
            { id: "org-a", kind: "team" },
            { id: "mine", kind: "personal", personal_user_id: "alice" },
        ],
        org_members: [
            { org_id: "org-a", user_id: "alice", role: "member" },
            { org_id: "org-a", user_id: "carol", role: "member" },
            { org_id: "org-a", user_id: "ivan", role: "admin" },
            { org_id: "org-a", user_id: "dave", role: "owner" },
            { org_id: "mine", user_id: "alice", role: "owner" },
        ],
        user_profiles: [
            { user_id: "carol", email: "carol@example.com" },
            { user_id: "erin", email: "erin@example.com" },
        ],
        chat_access_grants: [
            { chat_id: "shared", email: "carol@example.com", role: "editor" },
            { chat_id: "shared", email: "erin@example.com", role: "owner" },
            { chat_id: "left-owned", email: "carol@example.com", role: "owner" },
            { chat_id: "left-outside", email: "erin@example.com", role: "owner" },
            { chat_id: "personal", email: "erin@example.com", role: "viewer" },
        ],
        tabular_review_access_grants: [
            { tabular_review_id: "review", email: "carol@example.com", role: "viewer" },
        ],
    });
    const chat = (id: string, author: string, orgId: string | null = "org-a") => ({
        id,
        user_id: author,
        project_id: null,
        org_id: orgId,
    });
    const open = (
        row: ReturnType<typeof chat>,
        user: string,
        check = ensureChatAccess,
    ) => check(row, user, `${user}@example.com`, db);

    it("is its author's, as Owner", async () => {
        await expect(open(chat("private", "alice"), "alice")).resolves.toEqual({
            ok: true,
            isCreator: true,
            orgRole: "member",
            projectRole: "owner",
        });
    });

    it.each(["carol", "ivan", "dave"])(
        "is closed to %s, a colleague it was not shared with — whatever their role in the organization",
        async (user) => {
            await expect(
                open(chat("private", "alice"), user),
            ).resolves.toEqual({ ok: false });
        },
    );

    it("opens to a member it was shared with, at the role they were given", async () => {
        await expect(open(chat("shared", "alice"), "carol")).resolves.toEqual({
            ok: true,
            isCreator: false,
            orgRole: "member",
            projectRole: "editor",
        });
    });

    it("counts a grant held outside the organization for nothing", async () => {
        await expect(open(chat("shared", "alice"), "erin")).resolves.toEqual({
            ok: false,
        });
    });

    it("is taken over by nobody when its author is no longer in the organization", async () => {
        // The database deletes it with the author's membership. Should one
        // be left behind anyway, it opens for no one — not the author, who
        // has left, and not the organization's owners, whose it never was.
        const left = chat("left", "frank");
        for (const user of ["frank", "dave", "ivan", "carol"])
            await expect(open(left, user)).resolves.toEqual({ ok: false });
        await expect(
            open({ ...chat("orphan", "x"), user_id: null as unknown as string }, "dave"),
        ).resolves.toEqual({ ok: false });
    });

    it("stays with a member who was made its Owner, when its author leaves", async () => {
        const left = chat("left-owned", "frank");
        await expect(open(left, "carol")).resolves.toMatchObject({
            ok: true,
            projectRole: "owner",
        });
        await expect(open(left, "dave")).resolves.toEqual({ ok: false });
    });

    it("applies to tabular reviews in the same way", async () => {
        const review = chat("review", "alice");
        await expect(
            open(review, "alice", ensureReviewAccess),
        ).resolves.toMatchObject({ ok: true, projectRole: "owner" });
        await expect(
            open(review, "carol", ensureReviewAccess),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
        await expect(open(review, "dave", ensureReviewAccess)).resolves.toEqual({
            ok: false,
        });
    });

    it("leaves a chat in a personal organization on the personal rule: its author, and anyone it is shared with", async () => {
        const personal = chat("personal", "alice", "mine");
        await expect(open(personal, "alice")).resolves.toEqual({
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
        });
        await expect(open(personal, "erin")).resolves.toEqual({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "viewer",
        });
        await expect(open(personal, "dave")).resolves.toEqual({ ok: false });
    });
});

describe("resolveStandaloneOrgId", () => {
    const db = makeDb({
        organizations: [
            { id: "org-a", kind: "team" },
            { id: "mine", kind: "personal", personal_user_id: "alice" },
        ],
        org_members: [
            { org_id: "org-a", user_id: "alice", role: "member" },
            { org_id: "mine", user_id: "alice", role: "owner" },
        ],
    });

    it.each([undefined, null, ""])("is Personal for %j", async (orgId) => {
        await expect(
            resolveStandaloneOrgId(db, { userId: "alice", orgId }),
        ).resolves.toEqual({ ok: true, orgId: null });
    });

    it("is the organization the caller is working in", async () => {
        await expect(
            resolveStandaloneOrgId(db, { userId: "alice", orgId: "org-a" }),
        ).resolves.toEqual({ ok: true, orgId: "org-a" });
    });

    it.each([
        ["an organization the caller is not in", "bob", "org-a"],
        ["an organization that does not exist", "alice", "org-nowhere"],
        ["the caller's own personal organization, named by id", "alice", "mine"],
    ])("refuses %s", async (_label, userId, orgId) => {
        await expect(
            resolveStandaloneOrgId(db, { userId, orgId }),
        ).resolves.toEqual({
            ok: false,
            detail: "You are not a member of that organization.",
        });
    });

    it("refuses an org_id that is not a string", async () => {
        await expect(
            resolveStandaloneOrgId(db, { userId: "alice", orgId: ["org-a"] }),
        ).resolves.toEqual({ ok: false, detail: "org_id must be a string" });
    });
});

describe("ensureChatAccess", () => {
    // alice created proj-a inside org-a, open to the whole organization, and
    // is an org admin there; dave owns the organization, carol is a plain
    // org member, erin an outside
    // collaborator holding a viewer grant on proj-a and nothing else. bob
    // belongs to org-b only (the other tenant). frank is a member of nothing
    // and simply authored some of the chats.
    const db = makeDb({
        org_members: [
            { org_id: "org-a", user_id: "alice", role: "admin" },
            { org_id: "org-a", user_id: "carol", role: "member" },
            { org_id: "org-a", user_id: "dave", role: "owner" },
            { org_id: "org-b", user_id: "bob", role: "admin" },
        ],
        projects: [
            {
                id: "proj-a",
                user_id: "alice",
                org_id: "org-a",
                visibility: "organization",
            },
        ],
        project_access_grants: [
            { project_id: "proj-a", email: "erin@example.com", role: "viewer" },
        ],
        chat_access_grants: [
            { chat_id: "direct-chat", email: "carol@example.com", role: "editor" },
            { chat_id: "promoted-chat", email: "erin@example.com", role: "editor" },
            { chat_id: "admin-chat", email: "alice@example.com", role: "editor" },
        ],
    });

    it("makes a standalone chat's creator its Owner", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "creator-chat",
                    user_id: "carol",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                "carol@example.com",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
        });
    });

    it("gives a directly shared email Editor access, case-insensitively", async () => {
        // A standalone chat (no project, no org) is shareable through a
        // direct grant.
        await expect(
            ensureChatAccess(
                {
                    id: "direct-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                " CAROL@example.com ",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "editor",
        });
    });

    it("inherits the project verdict for a chat inside a project", async () => {
        // frank's chat lives in alice's project: everyone with standing on
        // proj-a gets that same standing on the chat, and none of them
        // becomes its creator.
        const chat = {
            id: "project-chat",
            user_id: "frank",
            project_id: "proj-a",
            org_id: "org-a",
        };
        await expect(
            ensureChatAccess(chat, "alice", "alice@example.com", db),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "owner",
        });
        await expect(
            ensureChatAccess(chat, "dave", "dave@example.com", db),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "owner",
            projectRole: "owner",
        });
        await expect(
            ensureChatAccess(chat, "carol", "carol@example.com", db),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "member",
            projectRole: "editor",
        });
        // A direct project grant cannot cross into an organization scope.
        await expect(
            ensureChatAccess(chat, "erin", "erin@example.com", db),
        ).resolves.toEqual({ ok: false });
    });

    it("does not grant organization access to a standalone chat", async () => {
        const chat = {
            id: "org-chat",
            user_id: "alice",
            project_id: null,
            org_id: "org-a",
        };
        await expect(
            ensureChatAccess(chat, "carol", "carol@example.com", db),
        ).resolves.toEqual({ ok: false });
        await expect(
            ensureChatAccess(chat, "dave", "dave@example.com", db),
        ).resolves.toEqual({ ok: false });
    });

    it("ignores a child chat grant and enforces project access", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "promoted-chat",
                    user_id: "frank",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "erin",
                "erin@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("inherits the project Owner role and ignores a child chat grant", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "admin-chat",
                    user_id: "frank",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "alice",
                "alice@example.com",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "owner",
        });
    });

    it("denies another tenant's user and an unshared standalone chat", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "tenant-chat",
                    user_id: "alice",
                    project_id: "proj-a",
                    org_id: "org-a",
                },
                "bob",
                "bob@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });

        await expect(
            ensureChatAccess(
                {
                    id: "private-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                "carol@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("fails closed when the caller has no email to match a share against", async () => {
        await expect(
            ensureChatAccess(
                {
                    id: "direct-chat",
                    user_id: "alice",
                    project_id: null,
                    org_id: null,
                },
                "carol",
                null,
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });
});

// ---------------------------------------------------------------------------
// listAccessibleProjectIds — completeness and cost
//
// This helper scopes chat lists and similar collection reads, so a project it
// silently omits is a project the caller cannot find at all. The previous
// shape had two faults that only appear at a real firm's size: an unpaged
// `.in("org_id", …)` that PostgREST truncates at its db-max-rows cap, and a
// per-row `checkProjectAccess` fan-out of two or three round trips EACH.
// ---------------------------------------------------------------------------

/**
 * Wraps the fake above so every query it is handed is recorded — which table,
 * which filters, and every `.range()` page. Counting queries is the only way
 * to state "one batched read, not one per project" as an assertion.
 */
function makeRecordingDb(tables: Record<string, Row[]>) {
    const queries: {
        table: string;
        filters: string[];
        ranges: [number, number][];
    }[] = [];
    const base = makeDb(tables);
    const db = {
        rpc: base.rpc,
        from(table: string) {
            const record = {
                table,
                filters: [] as string[],
                ranges: [] as [number, number][],
            };
            queries.push(record);
            const inner = base.from(table);
            const proxy: unknown = new Proxy(inner, {
                get(target, prop, receiver) {
                    const value = Reflect.get(target, prop, receiver);
                    if (typeof value !== "function") return value;
                    return (...args: unknown[]) => {
                        if (prop === "range")
                            record.ranges.push([
                                args[0] as number,
                                args[1] as number,
                            ]);
                        if (prop === "eq" || prop === "in" || prop === "is")
                            record.filters.push(`${String(prop)}:${args[0]}`);
                        const out = (value as (...a: unknown[]) => unknown).apply(
                            target,
                            args,
                        );
                        return out === target ? proxy : out;
                    };
                },
            });
            return proxy;
        },
    } as any;
    return { db, queries };
}

describe("listAccessibleProjectIds", () => {
    const orgProjects = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
            id: `p${String(index).padStart(4, "0")}`,
            user_id: "founder",
            org_id: "org-1",
            visibility: "organization",
        }));

    it("pages through an org with more projects than one read returns", async () => {
        // 1500 matters, a 1000-row page. The unpaged read came back with the
        // first 1000 and no error, so the remaining 500 simply were not there
        // — and nothing in the response said so.
        const { db, queries } = makeRecordingDb({
            org_members: [{ org_id: "org-1", user_id: "u1", role: "member" }],
            projects: orgProjects(1500),
            project_access_grants: [],
            project_org_access_overrides: [],
        });

        const ids = await listAccessibleProjectIds("u1", "u1@example.com", db);

        expect(ids).toHaveLength(1500);
        expect(ids).toContain("p1499");
        // Each page is its own query, so collect the ranges across them.
        const orgReads = queries.filter(
            (query) =>
                query.table === "projects" &&
                query.filters.includes("in:org_id"),
        );
        // Two pages: a full one, then a short one that ends the loop.
        expect(orgReads.flatMap((query) => query.ranges)).toEqual([
            [0, 999],
            [1000, 1999],
        ]);
    });

    it("reads the overrides once for the whole org, not once per project", async () => {
        const { db, queries } = makeRecordingDb({
            org_members: [{ org_id: "org-1", user_id: "u1", role: "member" }],
            projects: orgProjects(40),
            project_access_grants: [],
            project_org_access_overrides: [],
        });

        await listAccessibleProjectIds("u1", "u1@example.com", db);

        const overrideReads = queries.filter(
            (query) => query.table === "project_org_access_overrides",
        );
        // One. The fan-out issued forty, plus a project row read and an
        // org-role read apiece.
        expect(overrideReads).toHaveLength(1);
        // Scoped by ORG, not by an `.in()` over every candidate project id —
        // that list is spliced into the PostgREST query string and grows with
        // the firm's matters until the request line is refused.
        // Every override the caller holds, not just the denials: a grant is
        // what admits them to a private project.
        expect(overrideReads[0].filters).toEqual(["in:org_id", "eq:user_id"]);
    });

    it("hides a denied org project from a member and an admin, but not from its creator or an owner", async () => {
        // The two exemptions checkProjectAccess applies, re-derived inline:
        // the creator and an organization owner keep Owner and cannot be
        // denied. Get this wrong in the batched shape and a partner loses
        // their own matter to a deny row their role should never have. An
        // admin has no such exemption: a wall holds against them.
        const tables = {
            org_members: [
                { org_id: "org-1", user_id: "member", role: "member" },
                { org_id: "org-1", user_id: "boss", role: "admin" },
                { org_id: "org-1", user_id: "principal", role: "owner" },
                { org_id: "org-1", user_id: "author", role: "member" },
            ],
            projects: [
                {
                id: "walled",
                user_id: "author",
                org_id: "org-1",
                visibility: "organization",
            },
                {
                id: "open",
                user_id: "author",
                org_id: "org-1",
                visibility: "organization",
            },
            ],
            project_access_grants: [],
            project_org_access_overrides: [
                {
                    project_id: "walled",
                    org_id: "org-1",
                    user_id: "member",
                    role: "deny",
                },
                {
                    project_id: "walled",
                    org_id: "org-1",
                    user_id: "boss",
                    role: "deny",
                },
                {
                    project_id: "walled",
                    org_id: "org-1",
                    user_id: "principal",
                    role: "deny",
                },
                {
                    project_id: "walled",
                    org_id: "org-1",
                    user_id: "author",
                    role: "deny",
                },
            ],
        };

        await expect(
            listAccessibleProjectIds(
                "member",
                "member@example.com",
                makeRecordingDb(tables).db,
            ),
        ).resolves.toEqual(["open"]);
        // An org admin can be: administering the organization is not a
        // reason to read a matter they have been walled off from.
        await expect(
            listAccessibleProjectIds(
                "boss",
                "boss@example.com",
                makeRecordingDb(tables).db,
            ),
        ).resolves.toEqual(["open"]);
        // An org owner cannot.
        await expect(
            listAccessibleProjectIds(
                "principal",
                "principal@example.com",
                makeRecordingDb(tables).db,
            ),
        ).resolves.toEqual(["walled", "open"]);
        // Neither can the project's own creator.
        await expect(
            listAccessibleProjectIds(
                "author",
                "author@example.com",
                makeRecordingDb(tables).db,
            ),
        ).resolves.toEqual(["walled", "open"]);
    });
});

describe("listAccessibleProjectIds and private organization projects", () => {
    // One organization, four projects by the same author:
    //   private    nobody else has been given it
    //   granted    private, shared with `member` as a viewer
    //   public     open to the whole organization
    //   walled     public, with `member` denied
    const tables = {
        org_members: [
            { org_id: "org-1", user_id: "member", role: "member" },
            { org_id: "org-1", user_id: "manager", role: "admin" },
            { org_id: "org-1", user_id: "principal", role: "owner" },
            { org_id: "org-1", user_id: "author", role: "member" },
        ],
        projects: ["private", "granted", "public", "walled"].map((id) => ({
            id,
            user_id: "author",
            org_id: "org-1",
            visibility:
                id === "public" || id === "walled" ? "organization" : "private",
        })),
        project_access_grants: [],
        project_org_access_overrides: [
            {
                project_id: "granted",
                org_id: "org-1",
                user_id: "member",
                role: "viewer",
            },
            {
                project_id: "walled",
                org_id: "org-1",
                user_id: "member",
                role: "deny",
            },
        ],
    };
    const idsFor = async (userId: string) =>
        (
            await listAccessibleProjectIds(
                userId,
                `${userId}@example.com`,
                makeRecordingDb(tables).db,
            )
        ).sort();

    it("lists a member only what was shared with them or made public", async () => {
        expect(await idsFor("member")).toEqual(["granted", "public"]);
    });

    it("gives an admin no more than a member who was shared nothing", async () => {
        expect(await idsFor("manager")).toEqual(["public", "walled"]);
    });

    it("lists everything for the author", async () => {
        expect(await idsFor("author")).toEqual([
            "granted",
            "private",
            "public",
            "walled",
        ]);
    });

    it("lists the organization's owner only what is public, like an admin", async () => {
        // Neither the author's private project nor the one shared with
        // somebody else is the owner's to see.
        expect(await idsFor("principal")).toEqual(["public", "walled"]);
    });

    it("hands the owner the author's private projects once the author has left", async () => {
        const afterDeparture = {
            ...tables,
            org_members: tables.org_members.filter(
                (membership) => membership.user_id !== "author",
            ),
        };
        const idsAfter = async (userId: string) =>
            (
                await listAccessibleProjectIds(
                    userId,
                    `${userId}@example.com`,
                    makeRecordingDb(afterDeparture).db,
                )
            ).sort();

        // "granted" was shared with a member as a Viewer, not an Owner, so
        // it has no Owner left either.
        expect(await idsAfter("principal")).toEqual([
            "granted",
            "private",
            "public",
            "walled",
        ]);
        // An admin gains nothing from the departure.
        expect(await idsAfter("manager")).toEqual(["public", "walled"]);
        expect(await idsAfter("member")).toEqual(["granted", "public"]);
    });

    it("lists nothing for somebody outside the organization", async () => {
        expect(await idsFor("stranger")).toEqual([]);
    });
});

describe("listAccessibleProjectIds fails closed", () => {
    // A failed read used to be indistinguishable from an empty one: PostgREST
    // answers `{ data: null, error }`, and `?? []` turned that into "no rows".
    // For the deny-override read that widened the scope to every org project,
    // walled ones included, whenever the override table was unreadable.
    const base = () => ({
        org_members: [{ org_id: "org-1", user_id: "u1", role: "member" }],
        projects: [
            {
                id: "walled",
                user_id: "founder",
                org_id: "org-1",
                visibility: "organization",
            },
            {
                id: "open",
                user_id: "founder",
                org_id: "org-1",
                visibility: "organization",
            },
        ],
        project_access_grants: [],
        project_org_access_overrides: [
            {
                project_id: "walled",
                org_id: "org-1",
                user_id: "u1",
                role: "deny",
            },
        ],
    });

    it("hides the walled project when the override table answers", async () => {
        const ids = await listAccessibleProjectIds(
            "u1",
            "u1@example.com",
            makeDb(base()),
        );
        expect(ids).toEqual(["open"]);
    });

    it("throws instead of listing the walled project when the override read fails", async () => {
        const db = makeDb(base(), {
            selectErrors: { project_org_access_overrides: "statement timeout" },
        });
        await expect(
            listAccessibleProjectIds("u1", "u1@example.com", db),
        ).rejects.toThrow(/access override read failed: statement timeout/);
    });

    it("throws instead of truncating when a project page read fails", async () => {
        const db = makeDb(base(), {
            selectErrors: { projects: "connection reset" },
        });
        await expect(
            listAccessibleProjectIds("u1", "u1@example.com", db),
        ).rejects.toThrow(/project page read failed: connection reset/);
    });

    it("throws when the membership read fails", async () => {
        const db = makeDb(base(), {
            selectErrors: { org_members: "permission denied" },
        });
        await expect(
            listAccessibleProjectIds("u1", "u1@example.com", db),
        ).rejects.toThrow(/org membership read failed: permission denied/);
    });
});

describe("listAccessibleProjectIds with capped deny responses", () => {
    const projects = Array.from({ length: 1001 }, (_, index) => ({
        id: `denied-${String(index).padStart(4, "0")}`,
        user_id: "colleague",
        org_id: "firm",
        // Public, so it is the denial and nothing else that keeps each out.
        visibility: "organization",
    }));
    const tables = {
        org_members: [{ org_id: "firm", user_id: "member", role: "member" }],
        projects: [
            ...projects,
            {
                id: "open",
                user_id: "colleague",
                org_id: "firm",
                visibility: "organization",
            },
        ],
        project_org_access_overrides: projects.map((project) => ({
            project_id: project.id,
            org_id: "firm",
            user_id: "member",
            role: "deny",
        })),
    };

    it("keeps every denied matter out of the audit scope beyond 1,000 denials", async () => {
        const ids = await listAccessibleProjectIds(
            "member",
            undefined,
            makeDb(tables, { maxRows: 1000 }),
        );
        expect(ids).toEqual(["open"]);
    });

    it("fails closed if a later deny page cannot be read", async () => {
        const db = makeDb(tables, {
            maxRows: 1000,
            pageError: (table, from) =>
                table === "project_org_access_overrides" && from === 1000
                    ? "statement timeout"
                    : undefined,
        });
        await expect(
            listAccessibleProjectIds("member", undefined, db),
        ).rejects.toThrow(/access override read failed: statement timeout/);
    });
});


describe("explicit private organization access", () => {
    it("adds only viewer standing across all five kinds and loses it when revoked", async () => {
        const row = { id: "item", user_id: "member", org_id: "org", project_id: null, visibility: "private" };
        const db = makeDb({
            organizations: [{ id: "org", kind: "team" }],
            org_members: [{ org_id: "org", user_id: "admin", role: "admin" }, { org_id: "org", user_id: "member", role: "member" }],
            projects: [row], workflows: [row],
        });
        let opened = false;
        db.rpc = vi.fn(async (name: string) => ({ data: name === "org_private_document_access" ? opened : opened ? "viewer" : null, error: null }));
        const checks = [
            () => checkProjectAccess("item", "admin", "admin@example.test", db),
            () => checkWorkflowAccess("item", "admin", "admin@example.test", db),
            () => ensureChatAccess(row, "admin", "admin@example.test", db),
            () => ensureReviewAccess(row, "admin", "admin@example.test", db),
            () => ensureDocAccess(row, "admin", "admin@example.test", db),
        ];
        for (const check of checks) expect(await check()).toMatchObject({ ok: false });
        opened = true;
        for (const check of checks) expect(await check()).toMatchObject({ ok: true, projectRole: "viewer", isCreator: false });
        opened = false;
        for (const check of checks) expect(await check()).toMatchObject({ ok: false });
    });
    it("includes an explicitly opened project in the accessible-ID list", async () => {
        const db = makeDb({
            organizations: [{ id: "org", kind: "team" }],
            org_members: [{ org_id: "org", user_id: "admin", role: "admin" }, { org_id: "org", user_id: "member", role: "member" }],
            projects: [{ id: "private", org_id: "org", user_id: "member", visibility: "private" }, { id: "unopened", org_id: "org", user_id: "member", visibility: "private" }],
        });
        const original = db.rpc;
        db.rpc = vi.fn((name: string, args: Record<string, unknown>) => name === "list_org_private_content_access"
            ? Promise.resolve({ data: [{ kind: "project", item_id: "private" }], error: null }) : original(name, args));
        expect(await listAccessibleProjectIds("admin", "admin@example.test", db)).toEqual(["private"]);
    });
});
