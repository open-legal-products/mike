import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../lib/supabase";

const mocks = vi.hoisted(() => ({ role: vi.fn(), capture: vi.fn(), complete: vi.fn() }));
vi.mock("../../lib/access", () => ({ getOrgRole: mocks.role }));
vi.mock("../documents/documents.service", () => ({
    captureInlineDocumentCleanup: mocks.capture, completeInlineDocumentCleanup: mocks.complete,
}));
import {
    expireDepartureArchives, listDepartureArchives, listDepartures, resolveDepartureArchive, resolveDepartureArchives,
} from "./orgs.retention";

const actor = { orgId: "org", userId: "owner" };
function database(item: unknown = { kind: "document", item_id: "doc" }) {
    const query: any = {};
    for (const name of ["select", "eq", "lte", "order", "limit"]) query[name] = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: item, error: null }));
    query.then = (resolve: (result: unknown) => unknown) => Promise.resolve({ data: item ? [item] : [], error: null }).then(resolve);
    return { from: vi.fn(() => query), rpc: vi.fn(async () => ({ data: null as unknown, error: null as unknown })), query };
}
beforeEach(() => {
    vi.clearAllMocks(); mocks.role.mockResolvedValue("owner");
    mocks.capture.mockResolvedValue(["file.pdf"]); mocks.complete.mockResolvedValue(undefined);
});
describe("organization archive services", () => {
    it.each(["admin", "member", null])("does not read archive metadata for %s", async (role) => {
        mocks.role.mockResolvedValue(role);
        const db = database();
        for (const result of [
            await listDepartureArchives(db as unknown as Db, { ...actor, limit: 50, offset: 0 }),
            await resolveDepartureArchive(db as unknown as Db, { ...actor, archiveId: "a", delete: true }),
        ]) expect(result).toMatchObject({ ok: false, kind: role ? "forbidden" : "not_found" });
        expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
    });
    it("paginates through an RPC that rechecks owner authorization", async () => {
        const db = database(); db.rpc.mockResolvedValue({ data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null });
        expect(await listDepartureArchives(db as unknown as Db, { ...actor, limit: 2, offset: 4 })).toEqual({
            ok: true, data: { items: [{ id: "a" }, { id: "b" }], nextOffset: 6 },
        });
        expect(db.rpc).toHaveBeenCalledWith("list_org_departure_archives", { p_org_id: "org", p_actor_id: "owner", p_limit: 3, p_offset: 4 });
    });
    it("scopes archive lookup to the organization and does not mutate a missing archive", async () => {
        const db = database(null);
        expect(await resolveDepartureArchive(db as unknown as Db, { ...actor, archiveId: "foreign", delete: true })).toMatchObject({ kind: "not_found" });
        expect(db.query.eq).toHaveBeenCalledWith("org_id", "org"); expect(db.rpc).not.toHaveBeenCalled();
    });
    it("finishes file cleanup only after a successful database deletion", async () => {
        const db = database(); db.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
        const args = { ...actor, archiveId: "a", delete: true };
        expect(await resolveDepartureArchive(db as unknown as Db, args)).toMatchObject({ kind: "forbidden" });
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(await resolveDepartureArchive(db as unknown as Db, args)).toEqual({ ok: true, data: null });
        expect(mocks.capture).toHaveBeenCalledWith(db, { documentIds: ["doc"] });
        expect(mocks.complete).toHaveBeenCalledWith(db, ["file.pdf"]);
    });
    it("requires a successor and reports expired recovery without leaking database errors", async () => {
        const db = database();
        expect(await resolveDepartureArchive(db as unknown as Db, { ...actor, archiveId: "a", delete: false })).toMatchObject({ kind: "validation" });
        db.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "private db details" } });
        const result = await resolveDepartureArchive(db as unknown as Db, { ...actor, archiveId: "a", delete: false, successorId: "member" });
        expect(result).toMatchObject({ kind: "conflict" }); expect(JSON.stringify(result)).not.toContain("private db details");
        expect(mocks.capture).not.toHaveBeenCalled();
    });
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const work = (n: number, extra: Record<string, unknown> = {}) => ({
        id: id(n), kind: "chat", item_id: id(100 + n), title: `Item ${n}`,
        archived_at: "2026-10-01T00:00:00+00:00", expires_at: "2026-10-31T00:00:00+00:00",
        former_user_id: "jane", former_display_name: "Jane Doe", former_email: "jane@example.test",
        documents: null, chats: null, tabular_reviews: null, ...extra,
    });
    it.each(["admin", "member", null])("does not list or bulk-resolve departures for %s", async (role) => {
        mocks.role.mockResolvedValue(role);
        const db = database();
        for (const result of [
            await listDepartures(db as unknown as Db, actor),
            await resolveDepartureArchives(db as unknown as Db, { ...actor, archiveIds: [id(1)], delete: true }),
        ]) expect(result).toMatchObject({ ok: false, kind: role ? "forbidden" : "not_found" });
        expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
    });
    it("groups archived work by departure, with what a project holds and no name for a deleted account", async () => {
        const db = database();
        db.rpc.mockResolvedValue({ data: [
            work(1, { kind: "project", documents: 14, chats: 6, tabular_reviews: 0 }),
            work(2),
            // The same person leaving again later is a departure of its own.
            work(3, { archived_at: "2026-10-05T00:00:00+00:00", expires_at: "2026-11-04T00:00:00+00:00" }),
            work(4, { former_user_id: null, former_display_name: null, former_email: null,
                archived_at: "2026-10-09T00:00:00+00:00", expires_at: "2026-11-08T00:00:00+00:00" }),
        ], error: null });
        const result = await listDepartures(db as unknown as Db, actor);
        expect(db.rpc).toHaveBeenCalledWith("list_org_departure_work", { p_org_id: "org", p_actor_id: "owner", p_limit: 2001 });
        if (!result.ok) throw new Error("expected a listing");
        expect(result.data.truncated).toBe(false);
        expect(result.data.departures.map((d) => [d.member?.display_name ?? null, d.departed_at, d.expires_at, d.items.length])).toEqual([
            ["Jane Doe", "2026-10-01T00:00:00+00:00", "2026-10-31T00:00:00+00:00", 2],
            ["Jane Doe", "2026-10-05T00:00:00+00:00", "2026-11-04T00:00:00+00:00", 1],
            [null, "2026-10-09T00:00:00+00:00", "2026-11-08T00:00:00+00:00", 1],
        ]);
        const [project, chat] = result.data.departures[0].items;
        expect(project.contents).toEqual({ documents: 14, chats: 6, tabular_reviews: 0 });
        expect(chat).not.toHaveProperty("contents");
        expect(chat).not.toHaveProperty("former_email");
        expect(result.data.departures[0].member).toEqual({ user_id: "jane", display_name: "Jane Doe", email: "jane@example.test" });
        expect(result.data.departures[2].member).toBeNull();
    });
    it("says when there was more archived work than one listing holds", async () => {
        const db = database();
        db.rpc.mockResolvedValue({ data: Array.from({ length: 2001 }, (_, n) => work(n)), error: null });
        const result = await listDepartures(db as unknown as Db, actor);
        if (!result.ok) throw new Error("expected a listing");
        expect(result.data.truncated).toBe(true);
        expect(result.data.departures[0].items).toHaveLength(2000);
    });
    it.each([[undefined], [[]], [["not-an-id"]], [Array.from({ length: 501 }, (_, n) => id(n))]])(
        "refuses a bulk request without a sane list of items", async (archiveIds) => {
            const db = database();
            expect(await resolveDepartureArchives(db as unknown as Db, { ...actor, archiveIds, delete: true })).toMatchObject({ kind: "validation" });
            expect(db.rpc).not.toHaveBeenCalled();
        });
    it("resolves each item once, skips ones already gone and counts ones that could not be recovered", async () => {
        const db = database();
        db.query.maybeSingle
            .mockResolvedValueOnce({ data: { kind: "chat", item_id: "c" }, error: null })
            // A library file recovered along with the chat that used it.
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: { kind: "chat", item_id: "d" }, error: null });
        db.rpc.mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: null, error: { code: "23514" } });
        expect(await resolveDepartureArchives(db as unknown as Db, {
            ...actor, archiveIds: [id(1), id(2), id(1), id(3)], successorId: "member", delete: false,
        })).toEqual({ ok: true, data: { resolved: 1, unresolved: 1 } });
        expect(mocks.role).toHaveBeenCalledTimes(1);
        expect(db.rpc).toHaveBeenCalledTimes(2);
        expect(db.rpc).toHaveBeenCalledWith("resolve_org_departure_archive", expect.objectContaining({
            p_archive_id: id(1), p_successor_id: "member", p_delete: false,
        }));
    });
    it("stops a bulk reassignment that names no successor before touching anything", async () => {
        const db = database();
        expect(await resolveDepartureArchives(db as unknown as Db, { ...actor, archiveIds: [id(1), id(2)], delete: false })).toMatchObject({ kind: "validation" });
        expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
    });
    it("deletes in bulk with each item's file cleanup", async () => {
        const db = database();
        expect(await resolveDepartureArchives(db as unknown as Db, { ...actor, archiveIds: [id(1), id(2)], delete: true }))
            .toEqual({ ok: true, data: { resolved: 2, unresolved: 0 } });
        expect(mocks.capture).toHaveBeenCalledTimes(2); expect(mocks.complete).toHaveBeenCalledTimes(2);
    });
    it("expires in bounded batches and completes document cleanup", async () => {
        const db = database(); db.rpc.mockResolvedValue({ data: 1, error: null });
        expect(await expireDepartureArchives(db as unknown as Db)).toBe(1);
        expect(db.rpc).toHaveBeenCalledWith("expire_org_departure_archives", { p_limit: 100 });
        expect(mocks.complete).toHaveBeenCalledWith(db, ["file.pdf"]);
    });
});
