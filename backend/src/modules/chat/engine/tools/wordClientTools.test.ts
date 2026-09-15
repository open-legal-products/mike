import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_CONTEXT_CHARS } from "../contextBuilders";
import {
  APPLY_WORD_EDITS_TOOL_NAME,
  CLIENT_TOOL_TIMEOUT_RESULT,
  applyTimeoutMsFor,
  READ_ACTIVE_DOCUMENT_TOOL_NAME,
  TOOL_EDIT_BLOCK_INDEX_BASE,
  buildApplyResultPayload,
  createWordClientToolsAdapter,
  isWordClientToolName,
  normalizeEditOutcomes,
  parseWordEditsInput,
  pendingClientToolCallCount,
  submitClientToolResult,
  waitForClientToolResult,
} from "./wordClientTools";

describe("client tool result bridge", () => {
  it("resolves the awaiting call with the payload the client posted", async () => {
    const pending = waitForClientToolResult({ callId: "call-1", userId: "u1" });
    expect(pendingClientToolCallCount()).toBe(1);
    expect(submitClientToolResult("call-1", "u1", { ok: true })).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(pendingClientToolCallCount()).toBe(0);
  });

  it("rejects delivery from a different user without consuming the call", async () => {
    const pending = waitForClientToolResult({ callId: "call-2", userId: "u1" });
    expect(submitClientToolResult("call-2", "attacker", { ok: true })).toBe(
      false,
    );
    expect(pendingClientToolCallCount()).toBe(1);
    expect(submitClientToolResult("call-2", "u1", "fine")).toBe(true);
    await expect(pending).resolves.toBe("fine");
  });

  it("returns false for unknown ids", () => {
    expect(submitClientToolResult("never-registered", "u1", {})).toBe(false);
  });

  it("resolves with an error payload on timeout, and expires the id", async () => {
    const pending = waitForClientToolResult({
      callId: "call-3",
      userId: "u1",
      timeoutMs: 5,
    });
    const result = (await pending) as { error?: string };
    expect(result.error).toMatch(/did not return a result/);
    expect(submitClientToolResult("call-3", "u1", {})).toBe(false);
  });

  it("rejects with AbortError when the chat stream aborts", async () => {
    const controller = new AbortController();
    const pending = waitForClientToolResult({
      callId: "call-4",
      userId: "u1",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(submitClientToolResult("call-4", "u1", {})).toBe(false);
  });
});

describe("tool ownership", () => {
  it("owns exactly the Word client tool names", () => {
    expect(isWordClientToolName(APPLY_WORD_EDITS_TOOL_NAME)).toBe(true);
    expect(isWordClientToolName(READ_ACTIVE_DOCUMENT_TOOL_NAME)).toBe(true);
    expect(isWordClientToolName("read_document")).toBe(false);
  });
});

describe("parseWordEditsInput", () => {
  it("accepts a well-formed batch and trims the reason", () => {
    const parsed = parseWordEditsInput({
      edits: [{ original: "teh", replacement: "the", reason: "  Typo.  " }],
    });
    expect(parsed).toEqual({
      ok: true,
      edits: [{ original: "teh", replacement: "the", reason: "Typo." }],
    });
  });

  it("accepts a formatting edit and dedupes its formats", () => {
    const parsed = parseWordEditsInput({
      edits: [
        {
          original: "Termination",
          formats: ["bold", "bold", "heading2"],
          reason: "Promote to a heading.",
        },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      edits: [
        {
          original: "Termination",
          replacement: "",
          formats: ["bold", "heading2"],
          reason: "Promote to a heading.",
        },
      ],
    });
  });

  it("requires exactly one of replacement or formats", () => {
    const both = parseWordEditsInput({
      edits: [{ original: "a", replacement: "b", formats: ["bold"] }],
    });
    expect(both.ok).toBe(false);
    const neither = parseWordEditsInput({ edits: [{ original: "a" }] });
    expect(neither.ok).toBe(false);
  });

  it("rejects an unsupported format and a bogus occurrence", () => {
    expect(
      parseWordEditsInput({
        edits: [{ original: "a", formats: ["strikethrough"] }],
      }).ok,
    ).toBe(false);
    expect(
      parseWordEditsInput({
        edits: [{ original: "a", replacement: "b", occurrence: "first" }],
      }).ok,
    ).toBe(false);
  });

  it("carries an explicit replace-all through", () => {
    const parsed = parseWordEditsInput({
      edits: [{ original: "Seller", replacement: "Vendor", occurrence: "all" }],
    });
    expect(parsed.ok === true && parsed.edits[0]?.occurrence).toBe("all");
  });

  it("rejects an empty batch", () => {
    expect(parseWordEditsInput({ edits: [] })).toEqual({
      ok: false,
      error: "edits must be a non-empty array",
    });
  });

  it("rejects an original longer than the canonical edit row allows", () => {
    // 200 is the storage limit (PUT /messages/:id/edits/:blockIndex); an edit
    // Word could apply but the row could never hold would lose its card.
    const parsed = parseWordEditsInput({
      edits: [{ original: "x".repeat(201), replacement: "y" }],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toMatch(/at most 200/);
  });

  it("rejects more edits than one call may carry", () => {
    const parsed = parseWordEditsInput({
      edits: Array.from({ length: 51 }, (_, index) => ({
        original: `original ${index}`,
        replacement: "x",
      })),
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toMatch(/Too many edits/);
  });
});

describe("normalizeEditOutcomes", () => {
  const requested = [
    { original: "a", replacement: "b" },
    { original: "c", replacement: "d" },
  ];

  it("keeps client-reported statuses and errors, keyed by index", () => {
    const outcomes = normalizeEditOutcomes(requested, {
      edits: [
        { index: 1, status: "ambiguous", matches: 3, error: "3 matches" },
        { index: 0, status: "applied", matches: 1 },
      ],
    });
    expect(outcomes).toEqual([
      { index: 0, status: "applied", matches: 1 },
      { index: 1, status: "ambiguous", matches: 3, error: "3 matches" },
    ]);
  });

  it("accepts the review-mode 'proposed' outcome", () => {
    const outcomes = normalizeEditOutcomes(requested, {
      edits: [
        { index: 0, status: "proposed", matches: 1 },
        { index: 1, status: "proposed", matches: 1 },
      ],
    });
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "proposed",
      "proposed",
    ]);
  });

  it("turns missing or malformed rows into errors, never silent success", () => {
    const outcomes = normalizeEditOutcomes(requested, {
      edits: [{ index: 0, status: "definitely-not-a-status" }],
    });
    expect(outcomes.map((o) => o.status)).toEqual(["error", "error"]);
  });

  it("spreads a top-level client error across every edit", () => {
    const outcomes = normalizeEditOutcomes(requested, {
      error: "Word crashed",
    });
    expect(outcomes).toEqual([
      { index: 0, status: "error", error: "Word crashed" },
      { index: 1, status: "error", error: "Word crashed" },
    ]);
  });
});

describe("buildApplyResultPayload", () => {
  it("counts proposed edits apart from applied and failed ones", () => {
    const payload = buildApplyResultPayload([
      { index: 0, status: "proposed", matches: 1 },
      { index: 1, status: "applied", matches: 1 },
      { index: 2, status: "not-found", matches: 0 },
    ]);
    expect(payload.applied).toBe(1);
    expect(payload.proposed).toBe(1);
    // A queued proposal is waiting on a human, not on the model: counting it
    // as failed is what would provoke a pointless retry.
    expect(payload.failed).toBe(1);
  });

  it("tells the model that a proposal is success and must not be retried", () => {
    const payload = buildApplyResultPayload([
      { index: 0, status: "proposed", matches: 1 },
    ]);
    const hints = payload.hints as Record<string, string>;
    expect(hints.proposed).toMatch(/success, not a failure/);
    expect(hints.proposed).toMatch(/must not be\s+retried/);
  });

  it("reports one row per non-applied edit and one hint per kind", () => {
    const payload = buildApplyResultPayload([
      { index: 0, status: "applied", matches: 1 },
      { index: 1, status: "not-found", matches: 0 },
      { index: 2, status: "not-found", matches: 0 },
    ]);
    const rows = payload.edits as { index: number; status: string }[];
    expect(rows.map((row) => row.index)).toEqual([1, 2]);
    expect(Object.keys(payload.hints as object)).toEqual(["not-found"]);
  });

  it("passes Word's machine reason as skip_reason, not reason", () => {
    const payload = buildApplyResultPayload([
      {
        index: 0,
        status: "skipped",
        reason: "pre-existing-revisions",
      },
    ]);
    const rows = payload.edits as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ skip_reason: "pre-existing-revisions" });
    expect(rows[0]).not.toHaveProperty("reason");
  });
});

function collectSse(): {
  frames: Record<string, unknown>[];
  write: (s: string) => void;
} {
  const frames: Record<string, unknown>[] = [];
  return {
    frames,
    write: (s: string) => {
      const data = s.replace(/^data: /, "").trim();
      frames.push(JSON.parse(data) as Record<string, unknown>);
    },
  };
}

function lastToolCallFrame(
  frames: Record<string, unknown>[],
): Record<string, unknown> {
  const frame = [...frames].reverse().find((f) => f.type === "client_tool_call");
  if (!frame) throw new Error("no client_tool_call frame emitted");
  return frame;
}

describe("createWordClientToolsAdapter", () => {
  it("rejects invalid apply_word_edits input without a client round trip", async () => {
    const { frames, write } = collectSse();
    const adapter = createWordClientToolsAdapter({ userId: "u1", write });
    const { content, events } = await adapter.execute({
      id: "t1",
      name: APPLY_WORD_EDITS_TOOL_NAME,
      input: { edits: [] },
    });
    expect(JSON.parse(content)).toEqual({
      error: "edits must be a non-empty array",
    });
    expect(events).toEqual([]);
    expect(frames).toEqual([]);
  });

  it("forwards apply_word_edits over SSE and reports per-edit outcomes", async () => {
    const { frames, write } = collectSse();
    const adapter = createWordClientToolsAdapter({ userId: "u1", write });
    const execution = adapter.execute({
      id: "t1",
      name: APPLY_WORD_EDITS_TOOL_NAME,
      input: {
        edits: [
          { original: "teh", replacement: "the", reason: "Fix typo" },
          { original: "missing text", replacement: "", reason: "Delete" },
        ],
      },
    });
    // The frame is written synchronously when execute() starts awaiting.
    const frame = lastToolCallFrame(frames);
    expect(frame.name).toBe(APPLY_WORD_EDITS_TOOL_NAME);
    const input = frame.input as {
      block_index: number;
      edits: { original: string }[];
    };
    expect(input.edits).toHaveLength(2);
    // The pane keys its cards off this ordinal; both sides count from the
    // same base so their (message_id, block_index) rows converge.
    expect(input.block_index).toBe(TOOL_EDIT_BLOCK_INDEX_BASE);

    submitClientToolResult(frame.tool_call_id as string, "u1", {
      edits: [
        { index: 0, status: "proposed", matches: 1 },
        { index: 1, status: "not-found", matches: 0 },
      ],
    });
    const { content, events } = await execution;
    const parsed = JSON.parse(content) as {
      applied: number;
      proposed: number;
      failed: number;
      edits: { status: string }[];
      hints: Record<string, string>;
    };
    expect(parsed.applied).toBe(0);
    expect(parsed.proposed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.hints["not-found"]).toMatch(/Re-read the document/);
    // A placement marker per REQUESTED edit, failures included: the card is
    // the user's only record that the model tried.
    expect(events).toEqual([
      {
        type: "word_edit_block",
        block_index: TOOL_EDIT_BLOCK_INDEX_BASE,
        original_text: "teh",
        replacement_text: "the",
        formats: [],
        occurrence: null,
        reason: "Fix typo",
      },
      {
        type: "word_edit_block",
        block_index: TOOL_EDIT_BLOCK_INDEX_BASE + 1,
        original_text: "missing text",
        replacement_text: "",
        formats: [],
        occurrence: null,
        reason: "Delete",
      },
    ]);
  });

  it("continues the ordinal count across sequential calls, and not across rejected ones", async () => {
    const { frames, write } = collectSse();
    const adapter = createWordClientToolsAdapter({ userId: "u1", write });

    const first = adapter.execute({
      id: "t1",
      name: APPLY_WORD_EDITS_TOOL_NAME,
      input: {
        edits: [
          { original: "a", replacement: "b", reason: "r" },
          { original: "c", replacement: "d", reason: "r" },
        ],
      },
    });
    submitClientToolResult(lastToolCallFrame(frames).tool_call_id as string, "u1", {
      edits: [
        { index: 0, status: "proposed" },
        { index: 1, status: "proposed" },
      ],
    });
    await first;

    // A batch the schema rejects never reaches the pane, so it must not
    // consume ordinals the pane will never have counted.
    await adapter.execute({
      id: "t2",
      name: APPLY_WORD_EDITS_TOOL_NAME,
      input: { edits: [{ original: "", replacement: "x", reason: "r" }] },
    });

    const second = adapter.execute({
      id: "t3",
      name: APPLY_WORD_EDITS_TOOL_NAME,
      input: { edits: [{ original: "e", replacement: "f", reason: "r" }] },
    });
    const frame = lastToolCallFrame(frames);
    expect((frame.input as { block_index: number }).block_index).toBe(
      TOOL_EDIT_BLOCK_INDEX_BASE + 2,
    );
    submitClientToolResult(frame.tool_call_id as string, "u1", {
      edits: [{ index: 0, status: "proposed" }],
    });
    const { events } = await second;
    expect(events).toEqual([
      expect.objectContaining({
        block_index: TOOL_EDIT_BLOCK_INDEX_BASE + 2,
      }),
    ]);
  });

  it("round-trips read_active_document with read lifecycle frames", async () => {
    const { frames, write } = collectSse();
    const adapter = createWordClientToolsAdapter({
      userId: "u1",
      write,
      nonce: "test-nonce",
    });
    const execution = adapter.execute({
      id: "t2",
      name: READ_ACTIVE_DOCUMENT_TOOL_NAME,
      input: {},
    });
    expect(frames[0]).toMatchObject({ type: "doc_read_start" });
    const frame = lastToolCallFrame(frames);
    submitClientToolResult(frame.tool_call_id as string, "u1", {
      document: "Fresh body text",
    });
    const { content, events } = await execution;
    // The live body is untrusted input and must arrive spotlight-fenced.
    expect(content).toContain("Fresh body text");
    expect(content).toContain("test-nonce");
    // A label of its own: sharing the snapshot's filename would merge the
    // two reads into one activity row.
    expect(events).toEqual([
      { type: "doc_read", filename: "Active Word document (live)" },
    ]);
    expect(frames.some((f) => f.type === "doc_read")).toBe(true);
  });

  it("surfaces a client read failure as an error result", async () => {
    const { frames, write } = collectSse();
    const adapter = createWordClientToolsAdapter({ userId: "u1", write });
    const execution = adapter.execute({
      id: "t3",
      name: READ_ACTIVE_DOCUMENT_TOOL_NAME,
      input: {},
    });
    const frame = lastToolCallFrame(frames);
    submitClientToolResult(frame.tool_call_id as string, "u1", {
      error: "Office.js threw",
    });
    const { content } = await execution;
    expect(JSON.parse(content)).toEqual({ error: "Office.js threw" });
  });
});

describe("hardening: unconfirmed outcomes and unsearchable input", () => {
  it("rejects originals Word's search can never match", () => {
    const lineBreak = parseWordEditsInput({
      edits: [{ original: "one\ntwo", replacement: "x", reason: "r" }],
    });
    expect(lineBreak.ok).toBe(false);
    expect(lineBreak.ok === false && lineBreak.error).toMatch(/line break/);

    const caret = parseWordEditsInput({
      edits: [{ original: "a ^ b", replacement: "x", reason: "r" }],
    });
    expect(caret.ok).toBe(false);
    expect(caret.ok === false && caret.error).toMatch(/cannot match literally/);
  });

  it("maps a bridge timeout to unknown, not failed", () => {
    const requested = [{ original: "a", replacement: "b" }];
    const outcomes = normalizeEditOutcomes(
      requested,
      CLIENT_TOOL_TIMEOUT_RESULT,
    );
    expect(outcomes).toEqual([
      { index: 0, status: "unknown", error: CLIENT_TOOL_TIMEOUT_RESULT.error },
    ]);
    const payload = buildApplyResultPayload(outcomes);
    // A timed-out apply may still have landed. Calling it "failed" is what
    // makes the model retry and stack a second tracked change on the first.
    expect(payload.failed).toBe(0);
    expect(payload.unconfirmed).toBe(1);
    expect((payload.hints as Record<string, string>).unknown).toMatch(
      /read_active_document/,
    );
  });

  it("refuses a client that imitates the timeout sentinel's shape", () => {
    // Identity, not shape: a wire payload can copy the fields but can never
    // be reference-equal to the module-private constant.
    const forged = { ...CLIENT_TOOL_TIMEOUT_RESULT };
    const outcomes = normalizeEditOutcomes(
      [{ original: "a", replacement: "b" }],
      forged,
    );
    expect(outcomes[0]?.status).toBe("error");
  });

  it("refuses a client row that claims unknown outright", () => {
    const outcomes = normalizeEditOutcomes([{ original: "a", replacement: "b" }], {
      edits: [{ index: 0, status: "unknown" }],
    });
    expect(outcomes[0]?.status).toBe("error");
  });

  it("scales the apply deadline with batch size and caps it", () => {
    // Word Online pays several context.sync() host round trips PER edit; a
    // flat deadline times out big batches into exactly the unconfirmed-retry
    // ambiguity the timeout exists to avoid.
    expect(applyTimeoutMsFor(1)).toBe(33_000);
    expect(applyTimeoutMsFor(10)).toBe(60_000);
    expect(applyTimeoutMsFor(50)).toBe(180_000);
    expect(applyTimeoutMsFor(500)).toBe(180_000);
  });

  it("hints per skip reason rather than per row", () => {
    const payload = buildApplyResultPayload([
      { index: 0, status: "skipped", reason: "pre-existing-revisions" },
      { index: 1, status: "skipped", reason: "unsearchable" },
    ]);
    const hints = payload.hints as Record<string, string>;
    expect(hints["pre-existing-revisions"]).toMatch(/already contains/);
    expect(hints.unsearchable).toMatch(/shorter passage/);
  });

  it("records the edits as cards when the stream aborts mid-apply", async () => {
    const controller = new AbortController();
    const adapter = createWordClientToolsAdapter({
      userId: "u1",
      write: () => undefined,
      signal: controller.signal,
    });
    const execution = adapter.execute({
      id: "t1",
      name: APPLY_WORD_EDITS_TOOL_NAME,
      input: { edits: [{ original: "a", replacement: "b", reason: "r" }] },
    });
    controller.abort();
    const { content, events } = await execution;
    // The pane may already have written tracked changes; without the card
    // the user would have no way to find or undo them.
    expect(JSON.parse(content)).toEqual({
      error: "The chat stream was cancelled.",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "word_edit_block",
        block_index: TOOL_EDIT_BLOCK_INDEX_BASE,
      }),
    ]);
  });

  it("truncates an oversized live read at the snapshot ceiling", async () => {
    const frames: Record<string, unknown>[] = [];
    const adapter = createWordClientToolsAdapter({
      userId: "u1",
      write: (line) => {
        if (!line.startsWith("data: ")) return;
        frames.push(
          JSON.parse(line.replace(/^data: /, "").trim()) as Record<
            string,
            unknown
          >,
        );
      },
    });
    const execution = adapter.execute({
      id: "t2",
      name: READ_ACTIVE_DOCUMENT_TOOL_NAME,
      input: {},
    });
    const frame = frames.find((f) => f.type === "client_tool_call");
    submitClientToolResult(frame?.tool_call_id as string, "u1", {
      document: "x".repeat(MAX_DOCUMENT_CONTEXT_CHARS + 5_000),
    });
    const { content } = await execution;
    expect(content).toContain("[Document truncated at");
    expect(content.length).toBeLessThan(MAX_DOCUMENT_CONTEXT_CHARS + 1_000);
  });
});

describe("per-turn cost guards", () => {
  function silentAdapter() {
    const frames: Record<string, unknown>[] = [];
    const adapter = createWordClientToolsAdapter({
      userId: "u1",
      write: (line) => {
        if (!line.startsWith("data: ")) return;
        frames.push(
          JSON.parse(line.replace(/^data: /, "").trim()) as Record<
            string,
            unknown
          >,
        );
      },
      // Time every forwarded call out immediately.
      timeoutMs: 1,
    });
    return { adapter, frames };
  }

  it("stops forwarding after two consecutive timeouts", async () => {
    const { adapter, frames } = silentAdapter();
    const call = {
      id: "t",
      name: APPLY_WORD_EDITS_TOOL_NAME,
      input: { edits: [{ original: "a", replacement: "b", reason: "r" }] },
    };
    await adapter.execute(call);
    await adapter.execute(call);
    const forwardedAfterTwo = frames.filter(
      (frame) => frame.type === "client_tool_call",
    ).length;

    const third = await adapter.execute(call);
    // A wedged pane will not wake up mid-turn; every further call is a held
    // SSE socket plus a paid model round trip that goes nowhere.
    expect(JSON.parse(third.content).error).toMatch(/not responding/);
    expect(
      frames.filter((frame) => frame.type === "client_tool_call").length,
    ).toBe(forwardedAfterTwo);
  });

  it("caps live reads per turn and skips an unchanged re-read", async () => {
    const frames: Record<string, unknown>[] = [];
    const adapter = createWordClientToolsAdapter({
      userId: "u1",
      write: (line) => {
        if (!line.startsWith("data: ")) return;
        frames.push(
          JSON.parse(line.replace(/^data: /, "").trim()) as Record<
            string,
            unknown
          >,
        );
      },
    });
    const read = async (document: string): Promise<string> => {
      const execution = adapter.execute({
        id: "r",
        name: READ_ACTIVE_DOCUMENT_TOOL_NAME,
        input: {},
      });
      const frame = [...frames]
        .reverse()
        .find((f) => f.type === "client_tool_call");
      submitClientToolResult(frame?.tool_call_id as string, "u1", { document });
      return (await execution).content;
    };

    expect(await read("Body one")).toContain("Body one");
    // A byte-identical re-read is pure context amplification.
    const repeat = JSON.parse(await read("Body one")) as {
      unchanged?: boolean;
    };
    expect(repeat.unchanged).toBe(true);
    expect(await read("Body two")).toContain("Body two");
    const fourth = await adapter.execute({
      id: "r4",
      name: READ_ACTIVE_DOCUMENT_TOOL_NAME,
      input: {},
    });
    expect(JSON.parse(fourth.content).error).toMatch(/Already read/);
  });

  it("exhausts a per-turn call budget before the provider loop truncates", async () => {
    const adapter = createWordClientToolsAdapter({
      userId: "u1",
      write: () => undefined,
    });
    const call = {
      id: "t",
      name: "some_other_tool",
      input: {},
    };
    // The budget counts every owned-tool invocation, whatever it is.
    for (let index = 0; index < 12; index += 1) {
      const result = await adapter.execute(call);
      expect(JSON.parse(result.content).error).toMatch(/is not available/);
    }
    const overBudget = await adapter.execute(call);
    expect(JSON.parse(overBudget.content).error).toMatch(/budget/);
  });

  it("ignores posted rows whose index is outside the request", async () => {
    const outcomes = normalizeEditOutcomes([{ original: "a", replacement: "b" }], {
      edits: [
        { index: 5, status: "applied" },
        { index: -1, status: "applied" },
      ],
    });
    expect(outcomes[0]?.status).toBe("error");
  });
});
