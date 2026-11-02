import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAuditEvents } from "../audit.service";
import { buildAuditCsv, parseQuery } from "../../../lib/auditExport";
import {
    loadUserExportArtifact,
    startUserExport,
    validateExportRequest,
} from "../../user/user.export";

const mocks = vi.hoisted(() => ({
    role: "admin" as string | null,
    enqueue: vi.fn(),
    download: vi.fn(),
}));
vi.mock("../../../lib/access", () => ({
    getOrgRole: vi.fn(async () => mocks.role),
    isOrgAdmin: (r: string) => r === "owner" || r === "admin",
    listAccessibleProjectIds: vi.fn(async () => []),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({ enqueueDbJob: mocks.enqueue }));
vi.mock("../../../lib/storage", () => ({ downloadFile: mocks.download }));
const orgId = "00000000-0000-4000-8000-000000000010";
function database(job?: Record<string, unknown>) {
    const calls: unknown[][] = [];
    const events = [
        {
            id: "event",
            org_id: orgId,
            action: "org.created",
            title: "=unsafe",
            user_email: "owner@example.test",
        },
    ];
    const builder = (table: string) => {
        const q: Record<string, unknown> = {};
        for (const method of ["select", "eq", "order", "ilike", "gte", "lte"])
            q[method] = (...args: unknown[]) => {
                calls.push([table, method, ...args]);
                return q;
            };
        q.range = () =>
            Promise.resolve({ data: events, count: 1, error: null });
        q.in = () => Promise.resolve({ data: [], error: null });
        q.maybeSingle = () => Promise.resolve({ data: job, error: null });
        return q;
    };
    return {
        db: {
            from: (t: string) => builder(t),
            rpc: vi.fn((name: string, args: unknown) => {
                calls.push([name, args]);
                return Promise.resolve({ data: { events, total: events.length }, error: null });
            }),
        } as never,
        calls,
    };
}
const parsed = parseQuery({ org_id: orgId, action: "org.created" }, 2000);
const query = parsed.ok ? parsed.query : (undefined as never);
beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "admin";
    mocks.enqueue.mockResolvedValue({ id: "job" });
});

describe("organization audit authorization", () => {
    it("preserves username and selected ids in durable export jobs", () => {
        const eventIds = ["00000000-0000-4000-8000-000000000011"];
        expect(validateExportRequest({
            userId: "actor", userEmail: undefined,
            body: { type: "audit-csv", params: { org_id: orgId, username: "Alex", actor_user_id: eventIds[0], event_ids: eventIds } },
        })).toMatchObject({ ok: true, payload: { query: { orgId, userName: "Alex", actorUserId: eventIds[0], eventIds } } });
    });
    it.each(["owner", "admin"])(
        "lets %s list only the requested organization and applies filters",
        async (role) => {
            mocks.role = role;
            const { db, calls } = database();
            expect(
                await listAuditEvents(db, {
                    userId: "actor",
                    email: "actor@example.test",
                    query: { org_id: orgId, action: "org.created" },
                }),
            ).toMatchObject({ ok: true, data: { total: 1 } });
            expect(calls).toContainEqual([
                "organization_audit_events_page",
                expect.objectContaining({
                    p_org_id: orgId,
                    p_actor_id: "actor",
                    p_actor_email: "actor@example.test",
                    p_filter: expect.objectContaining({ action: "org.created" }),
                    p_sort_by: "created_at",
                    p_sort_direction: "desc",
                    p_offset: 0,
                    p_limit: 50,
                }),
            ]);
        },
    );
    it.each(["member", null])(
        "denies listing and building CSV to role %s",
        async (role) => {
            mocks.role = role;
            const { db, calls } = database();
            expect(
                await listAuditEvents(db, {
                    userId: "actor",
                    email: undefined,
                    query: { org_id: orgId },
                }),
            ).toMatchObject({ ok: false, kind: "forbidden" });
            await expect(
                buildAuditCsv(db, "actor", undefined, query),
            ).rejects.toThrow("access denied");
            expect(calls).toEqual([]);
        },
    );
    it("keeps scope in the queued export and escapes spreadsheet formulas", async () => {
        const { db } = database();
        const result = validateExportRequest({
            userId: "actor",
            userEmail: undefined,
            body: { type: "audit-csv", params: { org_id: orgId } },
        });
        expect(result).toMatchObject({
            ok: true,
            payload: { query: { orgId } },
        });
        const csv = await buildAuditCsv(db, "actor", undefined, query);
        expect(csv).toContain("organization_id");
        expect(csv).toContain("'=unsafe");
    });
    it("refuses queueing or downloading after admin access is revoked", async () => {
        const { db } = database({
            status: "done",
            payload: { userId: "actor", query },
            result: { storage_path: "exports/actor/a.csv" },
        });
        mocks.role = "member";
        expect(
            await startUserExport(db, {
                userId: "actor",
                type: "audit-csv",
                payload: { query },
            }),
        ).toMatchObject({ ok: false, forbidden: true });
        expect(await loadUserExportArtifact(db, "job", "actor")).toEqual({
            ok: false,
            kind: "not_found",
        });
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.download).not.toHaveBeenCalled();
    });
    it("rejects malformed organization filters rather than falling back to personal history", () => {
        for (const org_id of ["invalid", "", null, [orgId]])
            expect(parseQuery({ org_id }, 50)).toMatchObject({ ok: false });
    });
});
