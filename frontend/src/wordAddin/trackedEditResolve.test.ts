/**
 * Bulk accept/reject of Mike's tracked edits, through the add-in's public
 * restore + resolve API against a small in-memory Word host (the add-in
 * package has no unit-test runner of its own).
 *
 * The host keeps revision RECORDS (the document's state) and hands out proxy
 * objects per request context, like Office.js: a proxy can go stale while
 * its revision is still pending, and a sync runs its queued commands in
 * order, failing at the first one that touches a stale proxy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../word-addin/src/taskpane/lib/errorReporting", () => ({ reportWordFailure: vi.fn() }));

import { resolveTrackedEdits, restoreTrackedEdits } from "../../../word-addin/src/taskpane/hooks/useWordDoc";
import { bookmarkNameForEdit } from "../../../word-addin/src/taskpane/lib/wordEditAnchors";

type State = "pending" | "accept" | "reject";
type RevisionRecord = { id: string; type: "Added" | "Deleted"; text: string; bookmark: string | null; state: State };

function wordHost({ desktopRevisions = false } = {}) {
    const records: RevisionRecord[] = [];
    const proxies: { record: RevisionRecord; stale: boolean }[] = [];
    const refusals = new Set<string>();
    const deletedBookmarks: string[] = [];
    let runs = 0;

    class Context {
        queue: Array<() => void> = [];
        async sync() {
            const queue = this.queue.splice(0);
            for (const command of queue) command();
        }
        get document() {
            return document(this);
        }
    }
    const pendingIn = (bookmark?: string) =>
        records.filter((r) => r.state === "pending" && (bookmark === undefined || r.bookmark === bookmark));
    function trackedChange(context: Context, record: RevisionRecord) {
        const handle = { record, stale: false };
        proxies.push(handle);
        const live = () => {
            if (handle.stale) throw new Error("ItemNotFound");
            if (record.state !== "pending") throw new Error("ItemNotFound");
        };
        const decide = (decision: State) => () => {
            live();
            if (refusals.delete(record.id)) throw new Error("GeneralException");
            record.state = decision;
        };
        return {
            context,
            get type() { return record.type; },
            get text() { return record.text; },
            load: () => context.queue.push(live),
            accept: () => context.queue.push(decide("accept")),
            reject: () => context.queue.push(decide("reject")),
            track() {},
            untrack() {},
        };
    }
    function collection(context: Context, items: RevisionRecord[]) {
        return { context, items: items.map((r) => trackedChange(context, r)), load() {}, track() {}, untrack() {} };
    }
    function document(context: Context) {
        return {
            getBookmarkRangeOrNullObject: (name: string) => ({
                context,
                isNullObject: !records.some((r) => r.bookmark === name),
                load() {},
                track() {},
                untrack() {},
                getTrackedChanges: () => collection(context, pendingIn(name)),
            }),
            deleteBookmark: (name: string) => context.queue.push(() => deletedBookmarks.push(name)),
            body: { getTrackedChanges: () => collection(context, pendingIn()) },
            // The desktop Word.Revision surface (WordApiDesktop 1.4).
            get revisions() {
                return {
                    load() {},
                    items: pendingIn().map((record) => ({
                        type: record.type === "Added" ? "Insert" : "Delete",
                        range: { text: record.text },
                        accept: () => context.queue.push(() => { record.state = "accept"; }),
                        reject: () => context.queue.push(() => { record.state = "reject"; }),
                    })),
                };
            },
        };
    }

    const settings = new Map<string, unknown>();
    vi.stubGlobal("Office", {
        AsyncResultStatus: { Succeeded: "succeeded" },
        context: {
            requirements: { isSetSupported: (set: string) => set === "WordApiDesktop" && desktopRevisions },
            document: {
                settings: {
                    get: (key: string) => settings.get(key),
                    set: (key: string, value: unknown) => settings.set(key, value),
                    remove: (key: string) => settings.delete(key),
                    saveAsync: (cb: (result: { status: string }) => void) => cb({ status: "succeeded" }),
                },
            },
        },
    });
    vi.stubGlobal("Word", {
        run: async (...args: unknown[]) => {
            runs += 1;
            const batch = args.at(-1) as (context: Context) => Promise<unknown>;
            const objects = args.length > 1 ? (args[0] as { context: Context }[]) : [];
            return batch(objects[0]?.context ?? new Context());
        },
    });

    return {
        records,
        deletedBookmarks,
        get runs() { return runs; },
        /** Word refuses the next decision on this revision once (after a clean read-back). */
        refuseOnce(id: string) {
            refusals.add(id);
        },
        /** One of Mike's replacements, inside its persistent bookmark. */
        mikeEdit(stableEditId: string, original: string, replacement: string) {
            const bookmark = bookmarkNameForEdit(stableEditId);
            records.push(
                { id: `${stableEditId}:added`, type: "Added", text: replacement, bookmark, state: "pending" },
                { id: `${stableEditId}:deleted`, type: "Deleted", text: original, bookmark, state: "pending" },
            );
            return { stableEditId, edit: { original, replacement } };
        },
        /** A pending revision someone else made, outside Mike's passages. */
        foreignInsertion(id: string, text: string) {
            records.push({ id, type: "Added", text, bookmark: null, state: "pending" });
        },
        /** Word invalidated every proxy handed out so far. */
        invalidateProxies() {
            for (const proxy of proxies) proxy.stale = true;
        },
        stateOf: (id: string) => records.find((r) => r.id === id)?.state,
    };
}

async function restore(descriptors: { stableEditId: string; edit: { original: string; replacement: string } }[]) {
    const restored = await restoreTrackedEdits(descriptors);
    expect(restored.map((r) => r.status)).toEqual(descriptors.map(() => "restored"));
    return restored.map((r) => (r as { handle: Parameters<typeof resolveTrackedEdits>[0][number] }).handle);
}

afterEach(() => vi.unstubAllGlobals());

describe("bulk tracked-edit resolution", () => {
    it.each([
        ["accept", false],
        ["reject", false],
        ["accept", true],
        ["reject", true],
    ] as const)("%ss only each edit's own revisions after the user amended one (desktop surface: %s)", async (decision, desktopRevisions) => {
        const host = wordHost({ desktopRevisions });
        const first = host.mikeEdit("m:edit-0", "original clause", "replacement clause");
        const second = host.mikeEdit("m:edit-1", "second original", "second replacement");
        const handles = await restore([first, second]);
        // The user rewrote Mike's insertion; elsewhere, an unrelated pending
        // insertion now carries Mike's replacement text.
        host.records.find((r) => r.id === "m:edit-0:added")!.text = "user amended replacement";
        host.foreignInsertion("foreign", "replacement clause");

        const results = await resolveTrackedEdits(handles, decision);

        const verdict = decision === "accept" ? "accepted" : "rejected";
        expect(results.map((r) => r.status)).toEqual([verdict, verdict]);
        expect(host.stateOf("foreign")).toBe("pending");
        for (const id of ["m:edit-0:added", "m:edit-0:deleted", "m:edit-1:added", "m:edit-1:deleted"])
            expect(host.stateOf(id)).toBe(decision);
    });

    it("resolves two edits with identical text through their own revisions", async () => {
        const host = wordHost();
        const first = host.mikeEdit("m:edit-0", "the Seller", "the Vendor");
        const second = host.mikeEdit("m:edit-1", "the Seller", "the Vendor");
        const handles = await restore([first, second]);

        const results = await resolveTrackedEdits(handles, "accept");

        expect(results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
        expect(host.records.every((r) => r.state === "accept")).toBe(true);
    });

    it("falls back to each edit's own anchor when its retained proxies went stale", async () => {
        const host = wordHost();
        const first = host.mikeEdit("m:edit-0", "original clause", "replacement clause");
        const second = host.mikeEdit("m:edit-1", "second original", "second replacement");
        const handles = await restore([first, second]);
        host.invalidateProxies();
        host.foreignInsertion("foreign", "replacement clause");

        const results = await resolveTrackedEdits(handles, "accept");

        expect(results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
        expect(host.stateOf("foreign")).toBe("pending");
        expect(host.records.filter((r) => r.id.startsWith("m:")).every((r) => r.state === "accept")).toBe(true);
        // The read-back failed before anything was decided, so nothing was
        // resolved twice or reported as missing.
        expect((await resolveTrackedEdits(handles, "accept")).map((r) => r.status)).toEqual(["already-resolved", "already-resolved"]);
    });

    it("keeps the edits decided before a failed sync decided, with their cleanup", async () => {
        const host = wordHost();
        const edits = [0, 1, 2].map((i) => host.mikeEdit(`m:edit-${i}`, `original ${i}`, `replacement ${i}`));
        const handles = await restore(edits);
        // An Office batch is not a transaction: edit 0's accepts run, then
        // Word refuses edit 1's first revision.
        host.refuseOnce("m:edit-1:added");

        const results = await resolveTrackedEdits(handles, "accept");

        expect(results.map((r) => [r.status, r.error])).toEqual([
            ["accepted", undefined],
            ["accepted", undefined],
            ["accepted", undefined],
        ]);
        expect(host.records.every((r) => r.state === "accept")).toBe(true);
        expect(host.deletedBookmarks).toContain(bookmarkNameForEdit("m:edit-0"));
    });
});
