import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    role: null as string | null,
    roleReadFails: false,
    personal: false,
}));

vi.mock("../access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../access")>()),
    getOrgRoleOrThrow: vi.fn(async () => {
        if (mocks.roleReadFails) throw new Error("membership read failed");
        return mocks.role;
    }),
}));
vi.mock("../personalOrgs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../personalOrgs")>()),
    teamOrgIdOf: vi.fn(async (_db: unknown, orgId: string | null | undefined) =>
        orgId && !mocks.personal ? orgId : null,
    ),
}));

import {
    DEFAULT_ORG_PREFERENCES,
    loadOrgPreferences,
    loadWorkspacePreferences,
    orgPreferencesFromRow,
} from "../orgPreferences";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../webSearch";

/** An organizations read that answers with `row` or `error`. */
function orgDb(
    row: Record<string, unknown> | null,
    error: { code?: string; message: string } | null = null,
) {
    const reads: string[] = [];
    const q: Record<string, unknown> = {
        select: (columns: string) => {
            reads.push(columns);
            return q;
        },
        eq: () => q,
        maybeSingle: async () => ({ data: error ? null : row, error }),
    };
    const db = {
        from: (table: string) => {
            expect(table).toBe("organizations");
            return q;
        },
    };
    return { db: db as never, reads };
}

beforeEach(() => {
    mocks.role = null;
    mocks.roleReadFails = false;
    mocks.personal = false;
});

describe("orgPreferencesFromRow", () => {
    it("reads an organization that has chosen nothing as the app's defaults", () => {
        expect(orgPreferencesFromRow({})).toEqual(DEFAULT_ORG_PREFERENCES);
        expect(orgPreferencesFromRow(null)).toEqual(DEFAULT_ORG_PREFERENCES);
        expect(DEFAULT_ORG_PREFERENCES).toMatchObject({
            quick_actions_visible: true,
            response_details_visible: false,
            web_search: DEFAULT_WEB_SEARCH_SETTINGS,
        });
    });

    it("keeps valid choices and drops ones that are no longer valid", () => {
        expect(
            orgPreferencesFromRow({
                title_model: "claude-haiku-4-5",
                tabular_model: "  ",
                memory_curator_model: 7,
                subagent_model: "gpt-5",
                subagent_reasoning: "minimal",
                quick_actions_visible: false,
                response_details_visible: true,
                web_search: { enabled: true, other: "brave", claude: "bing" },
            }),
        ).toEqual({
            title_model: "claude-haiku-4-5",
            tabular_model: null,
            memory_curator_model: null,
            subagent_model: "gpt-5",
            // A level persisted under its old name reads as its successor.
            subagent_reasoning: "low",
            quick_actions_visible: false,
            response_details_visible: true,
            web_search: {
                enabled: true,
                claude: "provider",
                openai: "provider",
                other: "brave",
            },
        });
    });
});

describe("loadOrgPreferences", () => {
    it("reads the organization's row", async () => {
        const { db, reads } = orgDb({ title_model: "claude-haiku-4-5" });
        await expect(loadOrgPreferences(db, "org-1")).resolves.toMatchObject({
            title_model: "claude-haiku-4-5",
        });
        expect(reads[0]).toContain("web_search");
    });

    it("answers null for an organization that is not there", async () => {
        const { db } = orgDb(null);
        await expect(loadOrgPreferences(db, "org-1")).resolves.toBeNull();
    });

    it("reads a database that has not migrated as the defaults", async () => {
        const { db } = orgDb(null, {
            code: "42703",
            message: 'column organizations.title_model does not exist',
        });
        await expect(loadOrgPreferences(db, "org-1")).resolves.toEqual(
            DEFAULT_ORG_PREFERENCES,
        );
    });

    it("throws on any other failure rather than guessing", async () => {
        const { db } = orgDb(null, { code: "08006", message: "connection lost" });
        await expect(loadOrgPreferences(db, "org-1")).rejects.toThrow(
            "Failed to read the organization's preferences",
        );
    });
});

describe("loadWorkspacePreferences", () => {
    it("is null for Personal work", async () => {
        const { db, reads } = orgDb({ title_model: "claude-haiku-4-5" });
        await expect(loadWorkspacePreferences(db, "u1", null)).resolves.toBeNull();
        await expect(
            loadWorkspacePreferences(db, "u1", undefined),
        ).resolves.toBeNull();
        expect(reads).toEqual([]);
    });

    it("is null for a person's own organization", async () => {
        mocks.personal = true;
        mocks.role = "owner";
        const { db } = orgDb({ title_model: "claude-haiku-4-5" });
        await expect(
            loadWorkspacePreferences(db, "u1", "org-personal"),
        ).resolves.toBeNull();
    });

    it("is null for someone who is not a member, as their keys would be", async () => {
        const { db } = orgDb({ title_model: "claude-haiku-4-5" });
        await expect(
            loadWorkspacePreferences(db, "u1", "org-1"),
        ).resolves.toBeNull();
    });

    it("throws when membership cannot be read rather than answering Personal", async () => {
        mocks.roleReadFails = true;
        const { db, reads } = orgDb({ title_model: "claude-haiku-4-5" });
        await expect(
            loadWorkspacePreferences(db, "u1", "org-1"),
        ).rejects.toThrow("membership read failed");
        expect(reads).toEqual([]);
    });

    it("is the organization's for any member of a team organization", async () => {
        mocks.role = "member";
        const { db } = orgDb({
            title_model: "claude-haiku-4-5",
            quick_actions_visible: false,
        });
        await expect(
            loadWorkspacePreferences(db, "u1", "org-1"),
        ).resolves.toMatchObject({
            title_model: "claude-haiku-4-5",
            quick_actions_visible: false,
        });
    });
});
