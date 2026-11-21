import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
const mocks = vi.hoisted(() => ({ check: vi.fn(), latest: vi.fn(), active: vi.fn() }));
vi.mock("../../../lib/access", async load => ({ ...await load<object>(), createDocumentAccessChecker: () => mocks.check }));
vi.mock("../../../lib/documentVersions", () => ({ attachLatestVersionNumbers: mocks.latest, attachActiveVersionPaths: mocks.active }));
import { getDocumentStatuses } from "../documents.status";
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
beforeEach(() => { vi.clearAllMocks(); mocks.check.mockResolvedValue({ ok: true, projectRole: "owner", isCreator: true, orgRole: null }); });
describe("batch document status", () => {
    it("chunks 100 IDs and enriches only readable documents, retaining permission flags", async () => {
        const rows = Array.from({ length: 100 }, (_, n) => ({ id: id(n), user_id: "u", project_id: null }));
        mocks.check.mockImplementation(async doc => doc.id === id(1) ? { ok: false } : { ok: true, projectRole: "owner", isCreator: true, orgRole: null });
        const fake = scriptedDb([{ table: "documents", data: rows.slice(0, 50) }, { table: "documents", data: rows.slice(50) }]);
        const result = await getDocumentStatuses(fake.db, { documentIds: rows.map(row => row.id), userId: "u" });
        expect(result.ok && result.data).toHaveLength(99);
        expect(result.ok && result.data[0]).toMatchObject({ can_edit: true, can_delete: true });
        expect(mocks.active).toHaveBeenCalledTimes(2);
        for (const call of fake.calls) { expect(call.filters).toContainEqual(["is", "archived_at", null]); expect((call.filters[0][2] as string[]).length).toBe(50); }
        expect(mocks.active.mock.calls.flatMap(([, docs]) => docs).some(doc => doc.id === id(1))).toBe(false);
        fake.done();
    });
    it.each([null, ["bad"], Array.from({ length: 101 }, (_, n) => id(n))])("rejects invalid input before querying", async documentIds => {
        const fake = scriptedDb([]);
        expect(await getDocumentStatuses(fake.db, { documentIds, userId: "u" })).toMatchObject({ ok: false, kind: "validation" }); fake.done();
    });
    it("does not turn a failed database batch into missing documents", async () => {
        const fake = scriptedDb([{ table: "documents", error: { message: "offline" } }]);
        expect(await getDocumentStatuses(fake.db, { documentIds: [id(1)], userId: "u" })).toMatchObject({ ok: false, kind: "error" });
    });
});
