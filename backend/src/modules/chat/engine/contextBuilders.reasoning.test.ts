import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../../../lib/storage", () => ({ downloadFile: vi.fn() }));

import type { Db } from "../../../lib/supabase";
import {
  attachPriorReasoning,
  buildMessages,
  MAX_REPLAYED_REASONING_CHARS,
  MAX_REPLAYED_REASONING_TOTAL_CHARS,
} from "./contextBuilders";
import type { ChatMessage } from "./types";

type Row = { content: unknown };

const MODEL = "local-qwen";

/** Records the query it is given and resolves with the supplied rows. */
function makeDb(rows: Row[], error: unknown = null) {
  const calls: { table?: string; filters: Record<string, unknown> } = {
    filters: {},
  };
  const db = {
    from: (table: string) => {
      calls.table = table;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (column: string, value: unknown) => {
          calls.filters[column] = value;
          return b;
        },
        not: () => b,
        order: (column: string, opts: unknown) => {
          calls.filters[`order:${column}`] = opts;
          return b;
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: error ? null : rows, error }),
      };
      return b;
    },
  };
  return { db: db as unknown as Db, calls };
}

type Event = { type: string; text: string; model?: string };

const turn = (...events: Event[]): Row => ({ content: events });
/** A stored reasoning event; `null` stands for one stored before stamping. */
const thought = (text: string, model: string | null = MODEL): Event =>
  model === null ? { type: "reasoning", text } : { type: "reasoning", text, model };
const said = (text: string): Event => ({ type: "content", text });

describe("attachPriorReasoning", () => {
  it("attaches each stored turn's reasoning to the matching assistant message", async () => {
    const { db, calls } = makeDb([
      turn(thought("Plan the answer."), said("First "), said("answer.")),
      turn(
        thought("Read the clause."),
        { type: "doc_read", text: "ignored" },
        thought("Summarise it."),
        said("Second answer."),
      ),
    ]);
    const messages: ChatMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "q2" },
      { role: "assistant", content: "Second answer." },
      { role: "user", content: "q3" },
    ];

    const result = await attachPriorReasoning(messages, "chat-1", MODEL, db);

    expect(calls.table).toBe("chat_messages");
    expect(calls.filters).toMatchObject({ chat_id: "chat-1", role: "assistant" });
    expect(result.map((m) => m.reasoning)).toEqual([
      undefined,
      "Plan the answer.",
      undefined,
      "Read the clause.\n\nSummarise it.",
      undefined,
    ]);
    // The visible history is untouched.
    expect(result.map((m) => m.content)).toEqual(messages.map((m) => m.content));
  });

  it("never replays another model's reasoning, or reasoning stored without a model", async () => {
    const { db } = makeDb([
      turn(thought("From another model.", "other-model"), said("One.")),
      turn(thought("Stored before stamping.", null), said("Two.")),
      turn(
        thought("Mine.", MODEL),
        thought("Theirs.", "other-model"),
        said("Three."),
      ),
    ]);
    const result = await attachPriorReasoning(
      [
        { role: "assistant", content: "One." },
        { role: "assistant", content: "Two." },
        { role: "assistant", content: "Three." },
      ],
      "chat-1",
      MODEL,
      db,
    );
    expect(result.map((m) => m.reasoning)).toEqual([undefined, undefined, "Mine."]);
  });

  it("pairs repeated replies in order when every copy is present", async () => {
    const { db } = makeDb([
      turn(thought("r1"), said("Done.")),
      turn(thought("r2"), said("Done.")),
    ]);
    const result = await attachPriorReasoning(
      [
        { role: "assistant", content: "Done." },
        { role: "assistant", content: "Done." },
      ],
      "chat-1",
      MODEL,
      db,
    );
    expect(result.map((m) => m.reasoning)).toEqual(["r1", "r2"]);
  });

  it("does not guess between identical replies when the history omits one", async () => {
    const { db } = makeDb([
      turn(thought("r1"), said("Done.")),
      turn(thought("r2"), said("Unique.")),
      turn(thought("r3"), said("Done.")),
    ]);
    const result = await attachPriorReasoning(
      [
        { role: "assistant", content: "Unique." },
        { role: "assistant", content: "Done." },
      ],
      "chat-1",
      MODEL,
      db,
    );
    // "Done." is stored twice but sent once, so it could be either turn.
    expect(result.map((m) => m.reasoning)).toEqual(["r2", undefined]);
  });

  it("still matches unique replies in a shortened history", async () => {
    const { db } = makeDb([
      turn(thought("r1"), said("First.")),
      turn(thought("r2"), said("Second.")),
    ]);
    const [message] = await attachPriorReasoning(
      [{ role: "assistant", content: "First." }],
      "chat-1",
      MODEL,
      db,
    );
    expect(message.reasoning).toBe("r1");
  });

  it("leaves a message without a matching stored turn alone", async () => {
    const { db } = makeDb([turn(thought("r1"), said("Stored."))]);
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Edited by the client." },
    ];
    const result = await attachPriorReasoning(messages, "chat-1", MODEL, db);
    expect(result[0].reasoning).toBeUndefined();
  });

  it("keeps only the tail of very long reasoning", async () => {
    const long = `${"a".repeat(MAX_REPLAYED_REASONING_CHARS)}END`;
    const { db } = makeDb([turn(thought(long), said("Answer."))]);
    const [message] = await attachPriorReasoning(
      [{ role: "assistant", content: "Answer." }],
      "chat-1",
      MODEL,
      db,
    );
    expect(message.reasoning).toHaveLength(MAX_REPLAYED_REASONING_CHARS);
    expect(message.reasoning?.endsWith("END")).toBe(true);
  });

  it("spends the total budget on the newest turns and sends older ones as text", async () => {
    const perTurn = MAX_REPLAYED_REASONING_CHARS;
    const fits = Math.floor(MAX_REPLAYED_REASONING_TOTAL_CHARS / perTurn);
    const count = fits + 2;
    const { db } = makeDb(
      Array.from({ length: count }, (_, i) =>
        turn(thought(String(i).padEnd(perTurn, ".")), said(`Answer ${i}.`)),
      ),
    );
    const result = await attachPriorReasoning(
      Array.from({ length: count }, (_, i) => ({
        role: "assistant" as const,
        content: `Answer ${i}.`,
      })),
      "chat-1",
      MODEL,
      db,
    );
    const replayed = result.map((m) => m.reasoning !== undefined);
    expect(replayed).toEqual(
      Array.from({ length: count }, (_, i) => i >= count - fits),
    );
    const total = result.reduce((sum, m) => sum + (m.reasoning?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(MAX_REPLAYED_REASONING_TOTAL_CHARS);
  });

  it("stops at the first turn that does not fit, even if an older one would", async () => {
    const full = "f".repeat(MAX_REPLAYED_REASONING_CHARS);
    // Leaves 1,000 characters of budget after the three newest turns.
    const nearlyFull = "n".repeat(
      MAX_REPLAYED_REASONING_TOTAL_CHARS - 2 * full.length - 1_000,
    );
    const reasonings = ["tiny", "t".repeat(5_000), nearlyFull, full, full];
    const { db } = makeDb(
      reasonings.map((r, i) => turn(thought(r), said(`Answer ${i}.`))),
    );
    const result = await attachPriorReasoning(
      reasonings.map((_, i) => ({
        role: "assistant" as const,
        content: `Answer ${i}.`,
      })),
      "chat-1",
      MODEL,
      db,
    );
    // The 5,000-character turn does not fit the remaining 1,000, so it and the
    // older "tiny" turn go back as text: replay never skips over a gap.
    expect(result.map((m) => m.reasoning?.length)).toEqual([
      undefined,
      undefined,
      nearlyFull.length,
      full.length,
      full.length,
    ]);
  });

  it("reads the table it is given", async () => {
    const { db, calls } = makeDb([]);
    await attachPriorReasoning(
      [{ role: "assistant", content: "x" }],
      "chat-1",
      MODEL,
      db,
      "word_chat_messages",
    );
    expect(calls.table).toBe("word_chat_messages");
  });

  it("returns the history unchanged without a chat, an assistant turn, or a readable table", async () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "Answer." }];
    const stored = [turn(thought("r"), said("Answer."))];

    const noChat = makeDb(stored);
    expect(await attachPriorReasoning(messages, null, MODEL, noChat.db)).toBe(
      messages,
    );
    expect(noChat.calls.table).toBeUndefined();

    const userOnly: ChatMessage[] = [{ role: "user", content: "hi" }];
    const noAssistant = makeDb(stored);
    expect(
      await attachPriorReasoning(userOnly, "chat-1", MODEL, noAssistant.db),
    ).toBe(userOnly);
    expect(noAssistant.calls.table).toBeUndefined();

    const failing = makeDb(stored, { message: "boom" });
    expect(await attachPriorReasoning(messages, "chat-1", MODEL, failing.db)).toBe(
      messages,
    );
  });
});

describe("buildMessages reasoning passthrough", () => {
  it("carries reasoning on assistant turns only", () => {
    const formatted = buildMessages(
      [
        { role: "user", content: "q", reasoning: "never sent for users" },
        { role: "assistant", content: "a", reasoning: "why" },
        { role: "assistant", content: "b" },
      ],
      [],
    ) as Record<string, unknown>[];
    expect(formatted.slice(1)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning: "why" },
      { role: "assistant", content: "b" },
    ]);
  });
});
