import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadFileStrict = vi.fn();
vi.mock("../storage", () => ({
    downloadFileStrict: (...args: unknown[]) => downloadFileStrict(...args),
}));

import {
    buildProjectExportManifest,
    buildUserAccountExport,
} from "../userDataExport";

type Row = Record<string, unknown>;

// Read-only fake supporting the query subset buildUserAccountExport uses
// (select/range/eq/neq/in/order/filter + thenable).
function makeDb(tables: Record<string, Row[]>) {
    const reads: string[] = [];
    function query(table: string) {
        let rows = [...(tables[table] ?? [])];
        const builder: any = {
            select: () => builder,
            range: () => builder,
            order: () => builder,
            limit: () => builder,
            eq: (col: string, val: unknown) => {
                rows = rows.filter((r) => r[col] === val);
                return builder;
            },
            neq: (col: string, val: unknown) => {
                rows = rows.filter((r) => r[col] !== val);
                return builder;
            },
            is: (col: string, val: unknown) => {
                rows = rows.filter((r) => (r[col] ?? null) === val);
                return builder;
            },
            not: (col: string, op: string, val: unknown) => {
                if (op === "is" && val === null)
                    rows = rows.filter((r) => (r[col] ?? null) !== null);
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                rows = rows.filter((r) => vals.includes(r[col]));
                return builder;
            },
            filter: (col: string, op: string, value: string) => {
                reads.push(`${table}.${col}:${op}`);
                if (op !== "cs") return builder;
                const expected = JSON.parse(value) as string[];
                rows = rows.filter((r) => {
                    const actual = r[col];
                    return (
                        Array.isArray(actual) &&
                        expected.every((item) => actual.includes(item))
                    );
                });
                return builder;
            },
            maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
            single: async () => ({ data: rows[0] ?? null, error: null }),
            then: (
                resolve: (v: { data: Row[]; error: null }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
        };
        return builder;
    }
    return { db: { from: (t: string) => query(t) } as any, reads };
}

function markdownBytes(value: string): ArrayBuffer {
    return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

beforeEach(() => {
    downloadFileStrict.mockReset();
});

describe("account export: shared projects", () => {
    const tables = {
        projects: [
            { id: "own-p", user_id: "u1", name: "Mine", created_at: "1" },
            {
                id: "granted-p",
                user_id: "u2",
                name: "Granted",
                created_at: "2",
            },
            {
                id: "unshared-p",
                user_id: "u2",
                name: "Unshared",
                created_at: "3",
            },
        ],
        project_access_grants: [
            { project_id: "granted-p", email: "u1@example.com", role: "viewer" },
        ],
        tabular_reviews: [],
        chats: [],
        audit_events: [],
        documents: [],
        user_profiles: [],
    };

    it("lists exactly the grant-reachable projects", async () => {
        const { db, reads } = makeDb(tables);
        const exported = await buildUserAccountExport(db, "u1", "u1@example.com");
        const shared = (exported as any).shared_access.projects as Row[];
        expect(shared.map((p) => p.id)).toEqual(["granted-p"]);
        expect(reads.filter((r) => r.startsWith("projects."))).toEqual([]);
    });
});

describe("memory exports", () => {
    const markdown = "# Memory\n\n- Prefers concise drafts.\n";
    const hash =
        "6adb5e098c8e2d456cd117d73fbdb23cdf1b50f3bebb5f96e2e02acde6d24c83";

    it("includes the current app memory and retained Markdown revisions", async () => {
        const { db } = makeDb({
            memory_files: [
                {
                    id: "memory-user",
                    scope: "user",
                    user_id: "u1",
                    enabled: true,
                    epoch: 2,
                    version: 1,
                    current_version_id: "memory-version-1",
                    status: "idle",
                    created_at: "2026-09-05T00:00:00Z",
                    updated_at: "2026-09-05T00:01:00Z",
                },
            ],
            memory_file_versions: [
                {
                    id: "memory-version-1",
                    memory_file_id: "memory-user",
                    version: 1,
                    storage_path:
                        "memories/users/u1/versions/memory-version-1/memory.md",
                    content_sha256: hash,
                    size_bytes: new TextEncoder().encode(markdown).byteLength,
                    source: "manual",
                    updated_by: "u1",
                    model: null,
                    source_surface: null,
                    source_chat_id: null,
                    source_turn_id: null,
                    created_at: "2026-09-05T00:01:00Z",
                },
            ],
        });
        downloadFileStrict.mockResolvedValue(markdownBytes(markdown));

        const exported = await buildUserAccountExport(
            db,
            "u1",
            "u1@example.com",
        );

        expect(exported.memory).toMatchObject({
            enabled: true,
            version: 1,
            current_version_id: "memory-version-1",
            current: {
                id: "memory-version-1",
                content_sha256: hash,
                markdown,
            },
        });
        expect(exported.memory.versions).toHaveLength(1);
        expect(downloadFileStrict).toHaveBeenCalledWith(
            "memories/users/u1/versions/memory-version-1/memory.md",
        );
    });

    it("includes project memory in the signed project manifest", async () => {
        const { db } = makeDb({
            projects: [
                {
                    id: "p1",
                    name: "Matter",
                    cm_number: null,
                    created_at: "2026-09-05T00:00:00Z",
                },
            ],
            documents: [],
            memory_files: [
                {
                    id: "memory-project",
                    scope: "project",
                    project_id: "p1",
                    enabled: true,
                    epoch: 0,
                    version: 1,
                    current_version_id: "memory-version-1",
                    status: "idle",
                },
            ],
            memory_file_versions: [
                {
                    id: "memory-version-1",
                    memory_file_id: "memory-project",
                    version: 1,
                    storage_path:
                        "memories/projects/p1/versions/memory-version-1/memory.md",
                    content_sha256: hash,
                    size_bytes: new TextEncoder().encode(markdown).byteLength,
                    source: "curator",
                    updated_by: "u1",
                    model: "gpt-5-mini",
                    source_surface: "chat",
                    source_chat_id: "chat-1",
                    source_turn_id: "turn-1",
                    created_at: "2026-09-05T00:01:00Z",
                },
            ],
        });
        downloadFileStrict.mockResolvedValue(markdownBytes(markdown));

        const manifest = await buildProjectExportManifest(db, "p1");

        expect(manifest.memory).toMatchObject({
            enabled: true,
            current: {
                markdown,
                source: "curator",
                source_surface: "chat",
            },
        });
        expect(manifest.digest.value).toMatch(/^[0-9a-f]{64}$/);
    });
});
