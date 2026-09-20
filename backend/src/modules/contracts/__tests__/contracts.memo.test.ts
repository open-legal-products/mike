import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({ callJanusTool: vi.fn() }));
vi.mock("../../../lib/janusTools", () => ({ callJanusTool: mocks.callJanusTool }));

import { generateNegotiationMemo, isNegotiationMemo, parsePointStatusBody } from "../contracts.service";

const MEMO = { memo_title: "Memo Negosiasi: A — PKS", overall_tone_recommendation: "firm", must_change: [{ id: "NEG-MC-001" }], should_change: [], nice_to_discuss: [], do_not_raise: [], red_lines: [] };

beforeEach(() => vi.clearAllMocks());

describe("generateNegotiationMemo", () => {
  it("sends the review, feedback and past memos to run_negotiation_memo and stores the memo", async () => {
    mocks.callJanusTool.mockResolvedValue(JSON.stringify(MEMO));
    const fake = scriptedDb([
      { table: "reviews", data: { id: "r1", title: "PKS — A", client_name: "A", document_type: "PKS", ai_output: { revisions: [] } } },
      { table: "review_feedback", data: [{ finding_type: "revision", finding_id: "REV-001", action: "accept", rationale: null, edited_text: null }] },
      { table: "reviews", data: [{ id: "r1", title: "Self", negotiation_memo: { memo_title: "self" } }, { id: "r0", title: "Old", negotiation_memo: { memo_title: "x" } }, { id: "r2", title: "None", negotiation_memo: null }] },
      { table: "reviews", op: "update", data: null },
    ]);

    const r = await generateNegotiationMemo(fake.db as unknown as Db, { reviewId: "r1" });

    expect(r).toMatchObject({ ok: true, data: { memo: { memo_title: "Memo Negosiasi: A — PKS" } } });
    expect(mocks.callJanusTool).toHaveBeenCalledWith("run_negotiation_memo", expect.objectContaining({
      client_name: "A",
      document_type: "PKS",
      feedback: [expect.objectContaining({ finding_id: "REV-001" })],
      past_memos: [expect.objectContaining({ title: "Old" })],
    }));
    expect(fake.calls[3].payload).toMatchObject({ negotiation_memo: MEMO });
  });

  it("refuses a review without AI output and rejects an invalid memo", async () => {
    const noOutput = scriptedDb([{ table: "reviews", data: { id: "r1", ai_output: null } }]);
    expect(await generateNegotiationMemo(noOutput.db as unknown as Db, { reviewId: "r1" })).toMatchObject({ ok: false, kind: "conflict" });

    mocks.callJanusTool.mockResolvedValue(JSON.stringify({ error: "boom" }));
    const bad = scriptedDb([
      { table: "reviews", data: { id: "r1", client_name: "A", ai_output: { revisions: [] } } },
      { table: "review_feedback", data: [] },
      { table: "reviews", data: [] },
    ]);
    expect(await generateNegotiationMemo(bad.db as unknown as Db, { reviewId: "r1" })).toMatchObject({ ok: false, kind: "conflict" });
  });
});

describe("negotiation points", () => {
  it("validates statuses and memo shape", () => {
    expect(parsePointStatusBody({ status: "agreed" })).toMatchObject({ ok: true });
    expect(parsePointStatusBody({ status: "maybe" })).toMatchObject({ ok: false, kind: "validation" });
    expect(isNegotiationMemo(MEMO)).toBe(true);
    expect(isNegotiationMemo({ memo_title: "x" })).toBe(false);
  });
});
