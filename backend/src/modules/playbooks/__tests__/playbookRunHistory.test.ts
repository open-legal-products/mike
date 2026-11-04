import { describe, expect, it } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { listPlaybookRunHistory } from "../playbooks.operations";

const run = (id: string, playbook_id: string, n: number) => {
  const at = new Date(Date.UTC(2026, 9, 18) + n * 1000).toISOString();
  return {
    id, playbook_id, user_id: "owner", document_name: `${id}.pdf`, status: "completed",
    error: null, started_at: at, updated_at: at, completed_at: at,
  };
};

describe("playbook run history", () => {
  it("reads playbook access columns and names, never playbook content", async () => {
    const playbooks = Array.from({ length: 40 }, (_, i) => ({
      id: `book-${String(i).padStart(2, "0")}`, name: `Guide ${i}`, user_id: "owner",
      org_id: null, visibility: "private", content_json: { large: "x".repeat(1000) }, updated_at: "2026-10-01",
    }));
    const fake = tableDb({
      playbooks,
      org_members: [], playbook_org_access_overrides: [], playbook_shares: [], user_profiles: [],
      playbook_runs: [run("run", "book-07", 0)],
    });
    const selected: string[] = [];
    const db = {
      from: (table: string) => {
        const builder = fake.db.from(table) as unknown as { select: (columns: string) => unknown };
        const select = builder.select;
        builder.select = (columns: string) => (selected.push(`${table}: ${columns}`), select(columns));
        return builder;
      },
    } as unknown as typeof fake.db;
    const page = await listPlaybookRunHistory("owner", db, { workspace: "personal" });
    expect(page.map((entry) => [entry.id, entry.playbookName])).toEqual([["run", "Guide 7"]]);
    // Every playbook read (pages included) uses the narrow projection.
    expect([...new Set(selected.filter((call) => call.startsWith("playbooks:")))]).toEqual([
      "playbooks: id, name, user_id, org_id, visibility",
    ]);
  });

  it("returns an older visible run behind 300 newer runs of another workspace", async () => {
    const fake = tableDb({
      playbooks: [
        { id: "mine", name: "Mine", user_id: "owner", org_id: null, visibility: "private" },
        { id: "other", name: "Other", user_id: "owner", org_id: "other-org", visibility: "private" },
      ],
      org_members: [{ org_id: "other-org", user_id: "owner", role: "owner" }],
      playbook_org_access_overrides: [], playbook_shares: [], user_profiles: [],
      playbook_runs: [
        ...Array.from({ length: 300 }, (_, i) => run(`new-${i}`, "other", i + 1)),
        run("older-visible", "mine", 0),
      ],
    });
    const page = await listPlaybookRunHistory("owner", fake.db, { workspace: "personal", limit: 25 });
    expect(page.map((entry) => entry.id)).toEqual(["older-visible"]);
  });

  it("pages through visible runs interleaved with hidden ones, without duplicates or gaps", async () => {
    // 60 personal playbooks (two id batches), one shared playbook whose share
    // was revoked, and runs alternating between visible and hidden.
    const books = Array.from({ length: 60 }, (_, i) => ({
      id: `book-${String(i).padStart(2, "0")}`, name: `Guide ${i}`, user_id: "owner", org_id: null, visibility: "private",
    }));
    const runs = Array.from({ length: 90 }, (_, i) =>
      i % 3 === 2
        ? run(`hidden-${i}`, "revoked", i)
        : run(`run-${String(i).padStart(2, "0")}`, books[(i * 7) % 60].id, i),
    );
    // Two runs of different id batches tied on started_at.
    runs.push({ ...run("tie-a", "book-01", 45), id: "tie-a" }, { ...run("tie-b", "book-59", 45), id: "tie-b" });
    const fake = tableDb({
      playbooks: [...books, { id: "revoked", name: "Revoked", user_id: "someone", org_id: null, visibility: "private" }],
      org_members: [], playbook_org_access_overrides: [], user_profiles: [],
      playbook_shares: [],
      playbook_runs: runs,
    });
    const seen: string[] = [];
    let before: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await listPlaybookRunHistory("owner", fake.db, { email: "owner@example.com", limit: 7, before });
      if (!page.length) break;
      seen.push(...page.map((entry) => entry.id));
      before = page[page.length - 1].startedAt;
    }
    const expected = runs
      .filter((entry) => entry.playbook_id !== "revoked")
      .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))
      .map((entry) => entry.id);
    expect(seen).toEqual(expected);
    // Each page asks for at most one batch of playbook ids per request.
    expect(fake.calls.every((call) => call.inSizes.every((size) => size <= 50))).toBe(true);
  });

  it("finds runs of playbooks past the response cap of the playbook reads", async () => {
    const book = (id: string, org_id: string | null, visibility: string) =>
      ({ id, name: id, user_id: org_id ? "colleague" : "owner", org_id, visibility });
    const fake = tableDb({
      playbooks: [
        ...Array.from({ length: 12 }, (_, i) => book(`own-${String(i).padStart(2, "0")}`, null, "private")),
        ...Array.from({ length: 12 }, (_, i) => book(`org-${String(i).padStart(2, "0")}`, "org", "organization")),
      ],
      organizations: [{ id: "org", deleted_at: null }],
      org_members: [{ org_id: "org", user_id: "owner", role: "member", organizations: { id: "org" } }],
      playbook_org_access_overrides: [], playbook_shares: [], user_profiles: [],
      // Runs only on the playbooks that sort last by id.
      playbook_runs: [run("own-run", "own-11", 1), run("org-run", "org-11", 0)],
    }, { maxRows: 5 });
    const page = await listPlaybookRunHistory("owner", fake.db, {});
    expect(page.map((entry) => entry.id)).toEqual(["own-run", "org-run"]);
  });

  it("does not skip runs tied on started_at when a round ends inside the tie", async () => {
    const at = "2026-10-18T10:00:00.000Z";
    const run = (id: string, playbook_id: string) => ({
      id, playbook_id, user_id: "owner", document_name: `${id}.pdf`, status: "completed",
      error: null, started_at: at, updated_at: at, completed_at: at,
    });
    const fake = tableDb({
      playbooks: [
        { id: "mine", name: "Mine", user_id: "owner", org_id: null, visibility: "private", updated_at: at },
        // Another organization's playbook: the caller can no longer open it.
        { id: "gone", name: "Gone", user_id: "owner", org_id: "left-org", visibility: "private", updated_at: at },
      ],
      org_members: [], playbook_org_access_overrides: [], playbook_shares: [], user_profiles: [],
      playbook_runs: [run("r3", "gone"), run("r2", "mine"), run("r1", "mine")],
    });
    const page = await listPlaybookRunHistory("owner", fake.db, { limit: 2 });
    expect(page.map((entry) => entry.id)).toEqual(["r2", "r1"]);
  });
});
