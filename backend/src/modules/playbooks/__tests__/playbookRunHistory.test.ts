import { describe, expect, it } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { listPlaybookRunHistory } from "../playbooks.operations";

describe("playbook run history", () => {
  it("authorizes only the playbooks its runs name, not every reachable playbook", async () => {
    const playbooks = Array.from({ length: 40 }, (_, i) => ({
      id: `book-${String(i).padStart(2, "0")}`, name: `Guide ${i}`, user_id: "owner",
      org_id: null, visibility: "private", content_json: { large: "x".repeat(1000) }, updated_at: "2026-10-01",
    }));
    const fake = tableDb({
      playbooks,
      org_members: [], playbook_org_access_overrides: [], playbook_shares: [], user_profiles: [],
      playbook_runs: [{
        id: "run", playbook_id: "book-07", user_id: "owner", document_name: "a.pdf", status: "completed",
        error: null, started_at: "2026-10-18T10:00:00.000Z", updated_at: "2026-10-18T10:00:00.000Z",
        completed_at: "2026-10-18T10:00:00.000Z",
      }],
    });
    const page = await listPlaybookRunHistory("owner", fake.db, { workspace: "personal" });
    expect(page.map((run) => [run.id, run.playbookName])).toEqual([["run", "Guide 7"]]);
    const playbookRows = fake.calls.filter((call) => call.table === "playbooks").reduce((n, call) => n + call.returned, 0);
    expect(playbookRows).toBe(1);
  });
});
