import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantEvent, Message } from "@/app/components/shared/types";
import { streamChatTurn } from "./mikeApi";
import { beginAssistantTurn } from "./assistantTurns";
import {
  consumeAssistantTurnStream,
  createTurnCursor,
  createTurnEventSink,
  readAssistantTurn,
} from "./assistantTurnStream";

vi.mock("./mikeApi", () => ({ streamChatTurn: vi.fn(), stopChatTurn: vi.fn() }));
const streamChatTurnMock = vi.mocked(streamChatTurn);

/** An SSE body that emits the given chunks; `fail` makes it error out after them. */
function sseResponse(chunks: string[], opts?: { fail?: boolean; status?: number }) {
  const encoder = new TextEncoder();
  // `fail` errors the stream only once the consumer has drained the queued
  // chunks (pull runs when it asks for more), so the frames arrive first.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!opts?.fail) controller.close();
    },
    pull(controller) {
      if (opts?.fail) controller.error(new TypeError("network error"));
    },
  });
  return new Response(stream, { status: opts?.status ?? 200 });
}
const frame = (seq: number, data: object) => `id: ${seq}\ndata: ${JSON.stringify(data)}\n\n`;
const text = (message: Message) =>
  (message.events ?? []).map((e) => (e.type === "content" ? e.text : "")).join("");
const begin = () =>
  beginAssistantTurn("chat-a", {
    userMessage: { role: "user", content: "hello" },
    assistant: { role: "assistant", content: "", citations: [], events: [] },
    cancel: vi.fn(),
  });

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("consumeAssistantTurnStream", () => {
  it("tracks the chat, turn and last sequence number from the frames", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    const cursor = createTurnCursor("chat-a");
    const onChatId = vi.fn();
    await consumeAssistantTurnStream(
      sseResponse([
        frame(1, { type: "chat_id", chatId: "chat-a", turnId: "turn-1", assistantMessageId: "answer-1" }),
        frame(2, { type: "content_delta", text: "Hel" }),
        frame(3, { type: "content_delta", text: "lo" }),
        "id: 4\ndata: [DONE]\n\n",
      ]),
      { turn, sink, cursor, hooks: { onChatId } },
    );
    expect(cursor).toEqual({ chatId: "chat-a", turnId: "turn-1", lastSeq: 4 });
    expect(onChatId).toHaveBeenCalledWith("chat-a", "answer-1");
    expect(turn.turn.assistant.id).toBe("answer-1");
    expect(text(turn.turn.assistant)).toBe("Hello");
    turn.finish();
  });

  it("labels the answer when the server reports the turn was stopped elsewhere", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    await consumeAssistantTurnStream(
      sseResponse([
        frame(1, { type: "content_delta", text: "Partial" }),
        frame(2, { type: "cancelled" }),
        "data: [DONE]\n\n",
      ]),
      { turn, sink, cursor: createTurnCursor("chat-a") },
    );
    expect(turn.turn.assistant.events).toEqual([
      { type: "content", text: "Partial" },
      { type: "content", text: "Cancelled by user." },
    ]);
    turn.finish();
  });
});

describe("readAssistantTurn", () => {
  it("resumes from the frame after the last one seen when the connection drops", async () => {
    vi.useFakeTimers();
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    const cursor = createTurnCursor("chat-a");
    streamChatTurnMock.mockResolvedValueOnce(
      sseResponse([frame(3, { type: "content_delta", text: " world" }), "id: 4\ndata: [DONE]\n\n"]),
    );
    const read = readAssistantTurn({
      open: async () =>
        sseResponse(
          [
            frame(1, { type: "chat_id", chatId: "chat-a", turnId: "turn-1" }),
            frame(2, { type: "content_delta", text: "Hello" }),
          ],
          { fail: true },
        ),
      turn,
      sink,
      cursor,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await read;
    expect(streamChatTurnMock).toHaveBeenCalledWith({
      chatId: "chat-a",
      turnId: "turn-1",
      from: 3,
      signal: undefined,
    });
    expect(text(turn.turn.assistant)).toBe("Hello world");
    expect(cursor.lastSeq).toBe(4);
    turn.finish();
  });

  it("surfaces the original failure when the server no longer has the turn", async () => {
    vi.useFakeTimers();
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    streamChatTurnMock.mockResolvedValueOnce(sseResponse([], { status: 404 }));
    const read = readAssistantTurn({
      open: async () =>
        sseResponse([frame(1, { type: "chat_id", chatId: "chat-a", turnId: "turn-1" })], { fail: true }),
      turn,
      sink,
      cursor: createTurnCursor("chat-a"),
    });
    const outcome = read.then(() => "resolved", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe("network error");
    expect(streamChatTurnMock).toHaveBeenCalledTimes(1);
    turn.finish();
  });

  it("does not retry before the turn has a name, after Stop, or past the retry budget", async () => {
    vi.useFakeTimers();
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    // No chat_id frame yet: nothing to resume.
    await expect(
      readAssistantTurn({
        open: async () => sseResponse([frame(1, { type: "content_delta", text: "x" })], { fail: true }),
        turn,
        sink,
        cursor: createTurnCursor("chat-a"),
      }),
    ).rejects.toThrow("network error");
    expect(streamChatTurnMock).not.toHaveBeenCalled();

    // Stop aborts the read; an abort is final.
    const controller = new AbortController();
    const aborted = readAssistantTurn({
      open: async () => {
        controller.abort();
        return sseResponse([frame(1, { type: "chat_id", chatId: "chat-a", turnId: "turn-1" })]);
      },
      turn,
      sink,
      cursor: createTurnCursor("chat-a"),
      signal: controller.signal,
    });
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(streamChatTurnMock).not.toHaveBeenCalled();

    // Every reconnect drops too: give up after the budget.
    streamChatTurnMock.mockImplementation(async () =>
      sseResponse([frame(2, { type: "content_delta", text: "y" })], { fail: true }),
    );
    const exhausted = readAssistantTurn({
      open: async () =>
        sseResponse([frame(1, { type: "chat_id", chatId: "chat-a", turnId: "turn-1" })], { fail: true }),
      turn,
      sink,
      cursor: createTurnCursor("chat-a"),
      retries: 2,
    });
    const outcome = exhausted.then(() => "resolved", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBe("network error");
    expect(streamChatTurnMock).toHaveBeenCalledTimes(2);
    turn.finish();
  });

  it("rejects a response that is not ok before reading it", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    await expect(
      readAssistantTurn({
        open: async () => sseResponse([], { status: 409 }),
        turn,
        sink,
        cursor: createTurnCursor("chat-a"),
      }),
    ).rejects.toThrow("Chat request failed with status 409");
    turn.finish();
  });
});

/* ------------------------------------------------------------------ */
/* Frame-handler coverage                                             */
/* ------------------------------------------------------------------ */

type Frame = Record<string, unknown>;

/** Feed `frames` through one turn and hand back the finished assistant message. */
const run = async (frames: Frame[], initial?: AssistantEvent[]) => {
  const turn = begin();
  const sink = createTurnEventSink(turn, initial ?? []);
  await consumeAssistantTurnStream(
    sseResponse([...frames.map((f, i) => frame(i + 1, f)), "data: [DONE]\n\n"]),
    { turn, sink, cursor: createTurnCursor("chat-a") },
  );
  const { assistant } = turn.turn;
  turn.finish();
  return assistant;
};
const eventsOf = async (frames: Frame[], initial?: AssistantEvent[]) =>
  (await run(frames, initial)).events;

const thinking = { type: "thinking", isStreaming: true };
/** An event replayed from the server's stored copy of an earlier turn. */
const storedEvent = (event: Record<string, unknown>) =>
  event as unknown as AssistantEvent;
/** The smallest object `isPanelDocument` accepts. */
const panelDocument = {
  document_id: "doc-1",
  title: "Roe v. Wade",
  type: "case",
  metadata: [],
  quotes: [],
};

describe("stream identity frames", () => {
  it("adopts the chat id without a turn id, an answer id or hooks", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    const cursor = createTurnCursor();
    await consumeAssistantTurnStream(
      sseResponse([
        frame(1, { type: "chat_id", chatId: "chat-b", assistantMessageId: 7 }),
        "data: [DONE]\n\n",
      ]),
      { turn, sink, cursor },
    );
    expect(cursor).toEqual({ chatId: "chat-b", lastSeq: 1 });
    expect(turn.turn.assistant.id).toBeUndefined();
    turn.finish();
  });

  it("ignores a frame id that is not a sequence number", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    const cursor = createTurnCursor("chat-a");
    await consumeAssistantTurnStream(
      sseResponse([
        `id: not-a-number\ndata: ${JSON.stringify({ type: "content_delta", text: "a" })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      { turn, sink, cursor },
    );
    expect(cursor.lastSeq).toBe(0);
    turn.finish();
  });

  it("reports a renamed chat to the host only when the frame is well formed", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    const onChatTitle = vi.fn();
    await consumeAssistantTurnStream(
      sseResponse([
        frame(1, { type: "chat_title", chatId: 7, title: "Kept" }),
        frame(2, { type: "chat_title", chatId: "chat-a", title: 7 }),
        frame(3, { type: "chat_title", chatId: "chat-a", title: "Renamed" }),
        "data: [DONE]\n\n",
      ]),
      { turn, sink, cursor: createTurnCursor("chat-a"), hooks: { onChatTitle } },
    );
    expect(onChatTitle).toHaveBeenCalledTimes(1);
    expect(onChatTitle).toHaveBeenCalledWith("chat-a", "Renamed");
    turn.finish();
  });

  it("tolerates a chat_title frame when the host registered no hook", async () => {
    expect(
      await eventsOf([{ type: "chat_title", chatId: "chat-a", title: "Renamed" }]),
    ).toEqual([]);
  });

  it("marks the turn as loading citations when content is done", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    await consumeAssistantTurnStream(
      sseResponse([frame(1, { type: "content_done" }), "data: [DONE]\n\n"]),
      { turn, sink, cursor: createTurnCursor("chat-a") },
    );
    expect(turn.turn.loadingCitations).toBe(true);
    turn.finish();
  });

  it("ignores a frame type it does not know", async () => {
    expect(await eventsOf([{ type: "something_new", text: "x" }])).toEqual([]);
  });
});

describe("error frames", () => {
  it("shows the server's message only when it is marked safe to display", async () => {
    const message = await run([
      { type: "error", message: "  Upstream is down  ", safe_to_display: true },
    ]);
    expect(message.error).toBe("Upstream is down");
    expect(message.events).toEqual([
      { type: "error", message: "Upstream is down", safe_to_display: true },
    ]);
  });

  it.each([
    ["an unsafe message", { message: "stack trace", safe_to_display: false }, {}],
    [
      "a blank safe message",
      { message: "   ", safe_to_display: true },
      { safe_to_display: true },
    ],
    [
      "a safe message that is not a string",
      { message: 42, safe_to_display: true },
      { safe_to_display: true },
    ],
    ["no message at all", {}, {}],
  ])("falls back to a generic message for %s", async (_label, extra, flag) => {
    const message = await run([{ type: "error", ...extra }]);
    expect(message.error).toBe("Sorry, something went wrong.");
    expect(message.events).toEqual([
      { type: "error", message: "Sorry, something went wrong.", ...flag },
    ]);
  });

  it("raises a rejected key as its own signal and stops the citation spinner", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    const onRejectedApiKey = vi.fn();
    const onErrorFrame = vi.fn();
    await consumeAssistantTurnStream(
      sseResponse([
        frame(1, { type: "content_done" }),
        frame(2, { type: "reasoning_delta", text: "hmm" }),
        frame(3, { type: "tool_call_start", name: "t" }),
        frame(4, { type: "error", message: "bad key", code: "invalid_api_key" }),
        "data: [DONE]\n\n",
      ]),
      {
        turn,
        sink,
        cursor: createTurnCursor("chat-a"),
        hooks: { onRejectedApiKey, onErrorFrame },
      },
    );
    expect(onRejectedApiKey).toHaveBeenCalledTimes(1);
    expect(onErrorFrame).toHaveBeenCalledTimes(1);
    expect(turn.turn.loadingCitations).toBe(false);
    expect(turn.turn.assistant.events).toEqual([
      { type: "reasoning", text: "hmm" },
      {
        type: "error",
        message: "Sorry, something went wrong.",
        code: "invalid_api_key",
      },
    ]);
    turn.finish();
  });

  it("finalizes an in-flight content block before appending the error", async () => {
    expect(
      await eventsOf([
        { type: "content_delta", text: "Half an ans" },
        { type: "error", message: "boom" },
      ]),
    ).toEqual([
      { type: "content", text: "Half an ans" },
      { type: "error", message: "Sorry, something went wrong." },
    ]);
  });
});

describe("content and reasoning deltas", () => {
  it("starts a fresh content block after an interleaved event", async () => {
    expect(
      await eventsOf([
        { type: "content_delta", text: "before" },
        { type: "workflow_applied", workflow_id: "wf-1", title: "Intake" },
        { type: "content_delta", text: "after" },
      ]),
    ).toEqual([
      { type: "content", text: "before" },
      { type: "workflow_applied", workflow_id: "wf-1", title: "Intake" },
      { type: "content", text: "after", isStreaming: true },
    ]);
  });

  it("merges consecutive reasoning deltas and finalizes them at the end of the stream", async () => {
    expect(
      await eventsOf([
        { type: "reasoning_delta", text: "th" },
        { type: "reasoning_delta", text: "ink" },
      ]),
    ).toEqual([{ type: "reasoning", text: "think" }]);
  });

  it("closes a content block when reasoning starts, and stacks one placeholder after the block ends", async () => {
    expect(
      await eventsOf([
        { type: "content_delta", text: "answer" },
        { type: "reasoning_delta", text: "why" },
        { type: "reasoning_block_end" },
        { type: "reasoning_block_end" },
      ]),
    ).toEqual([
      { type: "content", text: "answer" },
      { type: "reasoning", text: "why" },
      thinking,
    ]);
  });
});

describe("tool placeholders and cancellation", () => {
  it.each([
    ["the tool's name", { name: "search" }, "search"],
    ["an empty name when the server omits one", {}, ""],
  ])("shows a running placeholder with %s", async (_label, extra, name) => {
    expect(await eventsOf([{ type: "tool_call_start", ...extra }])).toEqual([
      { type: "tool_call_start", name, isStreaming: true },
    ]);
  });

  it("labels the answer once, dropping placeholders and streaming flags", async () => {
    expect(
      await eventsOf([
        { type: "doc_read_start", filename: "brief.docx" },
        { type: "doc_read", filename: "brief.docx" },
        { type: "cancelled" },
        { type: "cancelled" },
      ]),
    ).toEqual([
      {
        type: "doc_read",
        filename: "brief.docx",
        document_id: undefined,
        version_id: null,
        version_number: null,
        isStreaming: false,
      },
      { type: "content", text: "Cancelled by user." },
    ]);
  });

  it("leaves events that never carried a streaming flag untouched", async () => {
    expect(
      await eventsOf([
        { type: "content_delta", text: "partial" },
        { type: "workflow_applied", workflow_id: "wf-1", title: "Intake" },
        { type: "cancelled" },
      ]),
    ).toEqual([
      { type: "content", text: "partial" },
      { type: "workflow_applied", workflow_id: "wf-1", title: "Intake" },
      { type: "content", text: "Cancelled by user." },
    ]);
  });
});

describe("case panel frames", () => {
  it("keeps every field of a fully populated case citation", async () => {
    expect(
      await eventsOf([
        {
          type: "case_citation",
          cluster_id: 12,
          case_name: "Roe v. Wade",
          citation: "410 U.S. 113",
          url: "https://cl/12",
          pdfUrl: "https://cl/12.pdf",
          dateFiled: "1973-01-22",
          document: panelDocument,
        },
      ]),
    ).toEqual([
      {
        type: "case_citation",
        cluster_id: 12,
        case_name: "Roe v. Wade",
        citation: "410 U.S. 113",
        url: "https://cl/12",
        pdfUrl: "https://cl/12.pdf",
        dateFiled: "1973-01-22",
        document: panelDocument,
      },
    ]);
  });

  it("nulls out case-citation fields the server sent with the wrong shape", async () => {
    expect(
      await eventsOf([
        {
          type: "case_citation",
          cluster_id: "12",
          case_name: 1,
          citation: 2,
          url: "https://cl/12",
          pdfUrl: 3,
          dateFiled: 4,
          document: { document_id: "doc-1" },
        },
      ]),
    ).toEqual([
      {
        type: "case_citation",
        cluster_id: null,
        case_name: null,
        citation: null,
        url: "https://cl/12",
        pdfUrl: null,
        dateFiled: null,
        document: undefined,
      },
    ]);
  });

  it.each([
    [
      "a document panel",
      { cluster_id: 12, document: panelDocument },
      { cluster_id: 12, document: panelDocument },
    ],
    ["nothing usable", {}, { cluster_id: 0, document: undefined }],
  ])("renders case opinions with %s", async (_label, extra, expected) => {
    expect(await eventsOf([{ type: "case_opinions", ...extra }])).toEqual([
      { type: "case_opinions", ...expected },
    ]);
  });
});

describe("MCP tool frames", () => {
  it("resolves a running MCP call into its result", async () => {
    expect(
      await eventsOf([
        { type: "mcp_tool_start", name: "drive__search" },
        {
          type: "mcp_tool_result",
          name: "drive__search",
          connector_name: "Drive",
          tool_name: "search",
          status: "error",
          error: "rate limited",
        },
      ]),
    ).toEqual([
      {
        type: "mcp_tool_call",
        connector_id: "",
        connector_name: "Drive",
        tool_name: "search",
        openai_tool_name: "drive__search",
        status: "error",
        error: "rate limited",
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("falls back to the wire name and an ok status when the result is bare", async () => {
    expect(
      await eventsOf([{ type: "mcp_tool_start" }, { type: "mcp_tool_result" }]),
    ).toEqual([
      {
        type: "mcp_tool_call",
        connector_id: "",
        connector_name: "",
        tool_name: "",
        openai_tool_name: "",
        status: "ok",
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("only shows a placeholder when a result has no call to resolve", async () => {
    expect(
      await eventsOf([{ type: "mcp_tool_result", name: "drive__search" }]),
    ).toEqual([thinking]);
  });
});

describe("CourtListener frames", () => {
  it("resolves a case-law search into its result count", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_search_case_law_start", query: "habeas" },
        { type: "courtlistener_search_case_law", query: "habeas", result_count: 3 },
      ]),
    ).toEqual([
      {
        type: "courtlistener_search_case_law",
        query: "habeas",
        result_count: 3,
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("reports a failed case-law search with a zero count", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_search_case_law_start", query: "habeas" },
        { type: "courtlistener_search_case_law", query: "habeas", error: "upstream 500" },
      ]),
    ).toEqual([
      {
        type: "courtlistener_search_case_law",
        query: "habeas",
        result_count: 0,
        error: "upstream 500",
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("starts a case-law search placeholder with an empty query", async () => {
    expect(await eventsOf([{ type: "courtlistener_search_case_law_start" }])).toEqual([
      { type: "courtlistener_search_case_law", query: "", isStreaming: true },
    ]);
  });

  it("keeps only numeric cluster ids and well formed cases when fetching cases", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_get_cases_start", cluster_ids: [1, "x", 2] },
        {
          type: "courtlistener_get_cases",
          cluster_ids: [1, 2],
          case_count: 2,
          opinion_count: 5,
          cases: [
            {
              cluster_id: 5,
              case_name: "A v. B",
              citation: "1 U.S. 1",
              dateFiled: "2020-01-01",
              url: "https://cl/5",
            },
            { cluster_id: "5", case_name: 1, citation: 2, dateFiled: 3, url: 4 },
            null,
            ["not a case"],
          ],
          error: "partial",
        },
      ]),
    ).toEqual([
      {
        type: "courtlistener_get_cases",
        cluster_ids: [1, 2],
        case_count: 2,
        opinion_count: 5,
        cases: [
          {
            cluster_id: 5,
            case_name: "A v. B",
            citation: "1 U.S. 1",
            dateFiled: "2020-01-01",
            url: "https://cl/5",
          },
        ],
        error: "partial",
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("leaves the case list undefined when the server sends no cases", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_get_cases_start" },
        { type: "courtlistener_get_cases" },
      ]),
    ).toEqual([
      {
        type: "courtlistener_get_cases",
        cluster_ids: [],
        case_count: 0,
        opinion_count: 0,
        cases: undefined,
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("resolves a single-case find by cluster id and query", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_find_in_case_start", cluster_id: 7, query: "notice" },
        {
          type: "courtlistener_find_in_case",
          cluster_id: 7,
          query: "notice",
          total_matches: 4,
          case_name: "A v. B",
          citation: "1 U.S. 1",
        },
      ]),
    ).toEqual([
      {
        type: "courtlistener_find_in_case",
        cluster_id: 7,
        query: "notice",
        total_matches: 4,
        searches: undefined,
        case_name: "A v. B",
        citation: "1 U.S. 1",
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("parses a batch of searches and ignores the per-call cluster id and query", async () => {
    const searches = [
      {
        cluster_id: 1,
        query: "q1",
        total_matches: 2,
        case_name: "A v. B",
        citation: "1 U.S. 1",
        error: "slow",
      },
      { cluster_id: "1", query: 1, total_matches: "2", case_name: 2, citation: 3, error: 4 },
      null,
      ["nope"],
    ];
    const parsed = [
      {
        cluster_id: 1,
        query: "q1",
        total_matches: 2,
        case_name: "A v. B",
        citation: "1 U.S. 1",
        error: "slow",
      },
      {
        cluster_id: null,
        query: "",
        total_matches: 0,
        case_name: null,
        citation: null,
        error: undefined,
      },
    ];
    expect(
      await eventsOf([
        { type: "courtlistener_find_in_case_start", cluster_id: 7, query: "x", searches },
        { type: "courtlistener_find_in_case", cluster_id: 7, query: "x", searches },
      ]),
    ).toEqual([
      {
        type: "courtlistener_find_in_case",
        cluster_id: null,
        query: "",
        total_matches: 0,
        searches: parsed,
        case_name: null,
        citation: null,
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("does not resolve a batched find against a single-case placeholder", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_find_in_case_start" },
        {
          type: "courtlistener_find_in_case",
          searches: [{ cluster_id: 1, query: "q1" }],
        },
      ]),
    ).toEqual([
      {
        type: "courtlistener_find_in_case",
        cluster_id: null,
        query: "",
        searches: undefined,
        isStreaming: true,
      },
      thinking,
    ]);
  });

  it("resolves a find with no cluster id and reports its error", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_find_in_case_start", query: "" },
        { type: "courtlistener_find_in_case", query: "", error: "no such case" },
      ]),
    ).toEqual([
      {
        type: "courtlistener_find_in_case",
        cluster_id: null,
        query: "",
        total_matches: 0,
        searches: undefined,
        case_name: null,
        citation: null,
        error: "no such case",
        isStreaming: false,
      },
      thinking,
    ]);
  });

  // A resumed turn replays the server's stored events, which predate the
  // fields the current wire format always sends.
  it("resolves a stored search placeholder that carries no query", async () => {
    expect(
      await eventsOf(
        [{ type: "courtlistener_search_case_law", result_count: 2 }],
        [storedEvent({ type: "courtlistener_search_case_law", isStreaming: true })],
      ),
    ).toEqual([
      {
        type: "courtlistener_search_case_law",
        query: "",
        result_count: 2,
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("resolves a stored find placeholder that carries no query", async () => {
    expect(
      await eventsOf(
        [{ type: "courtlistener_find_in_case", total_matches: 1 }],
        [
          storedEvent({
            type: "courtlistener_find_in_case",
            cluster_id: null,
            isStreaming: true,
          }),
        ],
      ),
    ).toEqual([
      {
        type: "courtlistener_find_in_case",
        cluster_id: null,
        query: "",
        total_matches: 1,
        searches: undefined,
        case_name: null,
        citation: null,
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("resolves reading a case, with and without the case's details", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_read_case_start", cluster_id: 9 },
        {
          type: "courtlistener_read_case",
          cluster_id: 9,
          case_name: "A v. B",
          citation: "1 U.S. 1",
          opinion_count: 3,
          error: "truncated",
        },
        { type: "courtlistener_read_case_start" },
        { type: "courtlistener_read_case" },
      ]),
    ).toEqual([
      {
        type: "courtlistener_read_case",
        cluster_id: 9,
        case_name: "A v. B",
        citation: "1 U.S. 1",
        opinion_count: 3,
        error: "truncated",
        isStreaming: false,
      },
      {
        type: "courtlistener_read_case",
        cluster_id: null,
        case_name: null,
        citation: null,
        opinion_count: 0,
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("resolves citation verification, with and without counts", async () => {
    expect(
      await eventsOf([
        { type: "courtlistener_verify_citations_start", citation_count: 4 },
        {
          type: "courtlistener_verify_citations",
          citation_count: 4,
          match_count: 3,
          error: "one unverified",
        },
      ]),
    ).toEqual([
      {
        type: "courtlistener_verify_citations",
        citation_count: 4,
        match_count: 3,
        error: "one unverified",
        isStreaming: false,
      },
      thinking,
    ]);
    expect(
      await eventsOf([
        { type: "courtlistener_verify_citations_start" },
        { type: "courtlistener_verify_citations" },
      ]),
    ).toEqual([
      {
        type: "courtlistener_verify_citations",
        citation_count: 0,
        match_count: 0,
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });
});

describe("document frames", () => {
  it("fills in the version a read resolved to", async () => {
    expect(
      await eventsOf([
        {
          type: "doc_read_start",
          filename: "brief.docx",
          document_id: "doc-1",
          version_id: "ver-1",
          version_number: 1,
        },
        {
          type: "doc_read",
          filename: "brief.docx",
          document_id: "doc-2",
          version_id: "ver-2",
          version_number: 2,
        },
      ]),
    ).toEqual([
      {
        type: "doc_read",
        filename: "brief.docx",
        document_id: "doc-2",
        version_id: "ver-2",
        version_number: 2,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("keeps the placeholder's version when the read reports none", async () => {
    expect(
      await eventsOf([
        {
          type: "doc_read_start",
          filename: "brief.docx",
          document_id: "doc-1",
          version_id: "ver-1",
          version_number: 1,
        },
        { type: "doc_read", filename: "brief.docx" },
      ]),
    ).toEqual([
      {
        type: "doc_read",
        filename: "brief.docx",
        document_id: "doc-1",
        version_id: "ver-1",
        version_number: 1,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("only shows a placeholder when a read resolves no matching file", async () => {
    expect(await eventsOf([{ type: "doc_read", filename: "other.docx" }])).toEqual([
      thinking,
    ]);
  });

  it("fills in the match count and version a find resolved to", async () => {
    expect(
      await eventsOf([
        { type: "doc_find_start", filename: "brief.docx", query: "notice" },
        {
          type: "doc_find",
          filename: "brief.docx",
          query: "notice",
          document_id: "doc-1",
          version_id: "ver-1",
          version_number: 1,
          total_matches: 3,
        },
      ]),
    ).toEqual([
      {
        type: "doc_find",
        filename: "brief.docx",
        query: "notice",
        document_id: "doc-1",
        version_id: "ver-1",
        version_number: 1,
        total_matches: 3,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("keeps the placeholder's version and count when the find reports none", async () => {
    expect(
      await eventsOf([
        {
          type: "doc_find_start",
          filename: "brief.docx",
          query: "notice",
          document_id: "doc-1",
          version_id: "ver-1",
          version_number: 1,
        },
        { type: "doc_find", filename: "brief.docx", query: "notice" },
      ]),
    ).toEqual([
      {
        type: "doc_find",
        filename: "brief.docx",
        query: "notice",
        document_id: "doc-1",
        version_id: "ver-1",
        version_number: 1,
        total_matches: 0,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("starts a find placeholder with no version and no query", async () => {
    expect(await eventsOf([{ type: "doc_find_start", filename: "brief.docx" }])).toEqual(
      [
        {
          type: "doc_find",
          filename: "brief.docx",
          document_id: undefined,
          version_id: null,
          version_number: null,
          query: "",
          total_matches: 0,
          isStreaming: true,
        },
      ],
    );
  });

  it("attaches the download link and version to a created document", async () => {
    expect(
      await eventsOf([
        { type: "doc_created_start", filename: "answer.docx" },
        {
          type: "doc_created",
          filename: "answer.docx",
          download_url: "https://dl/1",
          document_id: "doc-1",
          version_id: "ver-1",
          version_number: 1,
        },
      ]),
    ).toEqual([
      {
        type: "doc_created",
        filename: "answer.docx",
        download_url: "https://dl/1",
        document_id: "doc-1",
        version_id: "ver-1",
        version_number: 1,
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("omits version details a created document did not report", async () => {
    expect(
      await eventsOf([
        { type: "doc_created_start", filename: "answer.docx" },
        { type: "doc_created", filename: "answer.docx", download_url: "https://dl/1" },
      ]),
    ).toEqual([
      {
        type: "doc_created",
        filename: "answer.docx",
        download_url: "https://dl/1",
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("appends a standalone download link", async () => {
    expect(
      await eventsOf([
        { type: "doc_download", filename: "answer.docx", download_url: "https://dl/1" },
      ]),
    ).toEqual([
      { type: "doc_download", filename: "answer.docx", download_url: "https://dl/1" },
    ]);
  });

  const copies = [
    { new_filename: "a.docx", document_id: "doc-1", version_id: "ver-1" },
    { new_filename: "b.docx", document_id: "doc-2", version_id: "ver-2" },
  ];
  it.each<[string, Frame, Frame]>([
    [
      "the reported count",
      { count: 3 },
      { count: 3, copies: undefined, error: undefined },
    ],
    [
      "the number of copies",
      { copies },
      { count: 2, copies, error: undefined },
    ],
    [
      "one by default",
      { error: "quota" },
      { count: 1, copies: undefined, error: "quota" },
    ],
  ])("replicates a document using %s", async (_label, extra, expected) => {
    expect(
      await eventsOf([
        { type: "doc_replicate_start", filename: "answer.docx" },
        { type: "doc_replicated", filename: "answer.docx", ...extra },
      ]),
    ).toEqual([
      {
        type: "doc_replicated",
        filename: "answer.docx",
        isStreaming: false,
        ...expected,
      },
      thinking,
    ]);
  });

  it("starts a replication placeholder with the reported count", async () => {
    expect(
      await eventsOf([
        { type: "doc_replicate_start", filename: "answer.docx", count: 4 },
      ]),
    ).toEqual([
      { type: "doc_replicated", filename: "answer.docx", count: 4, isStreaming: true },
    ]);
  });

  it("attaches the new version and annotations to an edited document", async () => {
    const annotations = [{ kind: "replace", old_text: "a", new_text: "b" }];
    expect(
      await eventsOf([
        { type: "doc_edited_start", filename: "brief.docx" },
        {
          type: "doc_edited",
          filename: "brief.docx",
          document_id: "doc-1",
          version_id: "ver-2",
          version_number: 2,
          download_url: "https://dl/2",
          annotations,
          error: "one edit skipped",
        },
      ]),
    ).toEqual([
      {
        type: "doc_edited",
        filename: "brief.docx",
        document_id: "doc-1",
        version_id: "ver-2",
        version_number: 2,
        download_url: "https://dl/2",
        annotations,
        error: "one edit skipped",
        isStreaming: false,
      },
      thinking,
    ]);
  });

  it("empties out an edited document the server described with nothing", async () => {
    expect(
      await eventsOf([
        { type: "doc_edited_start", filename: "brief.docx" },
        { type: "doc_edited", filename: "brief.docx" },
      ]),
    ).toEqual([
      {
        type: "doc_edited",
        filename: "brief.docx",
        document_id: "",
        version_id: "",
        version_number: null,
        download_url: "",
        annotations: [],
        error: undefined,
        isStreaming: false,
      },
      thinking,
    ]);
  });
});

describe("ask_inputs frames", () => {
  it("normalizes choice and multi-choice questions", async () => {
    expect(
      await eventsOf([
        {
          type: "ask_inputs",
          event_id: "  ask-1  ",
          items: [
            {
              id: "  jurisdiction  ",
              kind: "choice",
              question: "Which court?",
              options: [
                { value: "federal" },
                { label: "state" },
                { value: "   " },
                {},
                "not an option",
                null,
              ],
              allow_other: false,
              other_label: "Somewhere else",
              response_prefix: "Court: ",
            },
            { id: "   ", kind: "multi_choice" },
            { kind: "choice", options: "not a list" },
          ],
        },
      ]),
    ).toEqual([
      {
        type: "ask_inputs",
        event_id: "ask-1",
        items: [
          {
            id: "jurisdiction",
            kind: "choice",
            question: "Which court?",
            options: [{ value: "federal" }, { value: "state" }],
            allow_other: false,
            other_label: "Somewhere else",
            response_prefix: "Court: ",
          },
          {
            id: "input-2",
            kind: "multi_choice",
            question: "Please choose one or more options.",
            options: [],
            allow_other: true,
            other_label: "Other",
            response_prefix: undefined,
          },
          {
            id: "input-3",
            kind: "choice",
            question: "Please choose an option.",
            options: [],
            allow_other: true,
            other_label: "Other",
            response_prefix: undefined,
          },
        ],
      },
    ]);
  });

  it("normalizes text and document questions and drops the rest", async () => {
    expect(
      await eventsOf([
        {
          type: "ask_inputs",
          event_id: "ask-2",
          items: [
            { id: "note", kind: "text", question: "Anything else?", response_prefix: "Note: " },
            { kind: "text" },
            {
              kind: "documents",
              document_types: ["  lease  ", "   ", 7, "deed"],
              response_prefix: "Files: ",
            },
            { kind: "documents" },
            { kind: "unsupported" },
            null,
            "not an item",
          ],
        },
      ]),
    ).toEqual([
      {
        type: "ask_inputs",
        event_id: "ask-2",
        items: [
          {
            id: "note",
            kind: "text",
            question: "Anything else?",
            response_prefix: "Note: ",
          },
          {
            id: "input-2",
            kind: "text",
            question: "Please provide the requested information.",
            response_prefix: undefined,
          },
          {
            id: "input-3",
            kind: "documents",
            document_types: ["lease", "deed"],
            response_prefix: "Files: ",
          },
          {
            id: "input-4",
            kind: "documents",
            document_types: [],
            response_prefix: undefined,
          },
        ],
      },
    ]);
  });

  it.each([
    ["the event has no id", { items: [{ kind: "text" }] }],
    ["no item is usable", { event_id: "ask-3", items: [{ kind: "unsupported" }] }],
    ["the items are not a list", { event_id: "ask-4", items: "text" }],
  ])("asks nothing when %s", async (_label, extra) => {
    expect(await eventsOf([{ type: "ask_inputs", ...extra }])).toEqual([]);
  });
});

describe("citation frames", () => {
  const citations = [{ id: "c1", document_id: "doc-1", quote: "a quote" }];

  it.each([["started"], ["partial"]])(
    "publishes %s citations without touching the streaming answer",
    async (status) => {
      const message = await run([
        { type: "content_delta", text: "answer" },
        { type: "citations", status, citations },
      ]);
      expect(message.citations).toEqual(citations);
      expect(message.citationStatus).toBe(status);
      expect(message.events).toEqual([
        { type: "content", text: "answer", isStreaming: true },
      ]);
    },
  );

  it("finalizes the answer and scrubs placeholders on the last citation frame", async () => {
    const message = await run([
      { type: "content_delta", text: "answer" },
      { type: "tool_call_start", name: "search" },
      { type: "citations", status: "final", citations },
    ]);
    expect(message.citations).toEqual(citations);
    expect(message.citationStatus).toBe("final");
    expect(message.events).toEqual([{ type: "content", text: "answer" }]);
  });

  it("treats an unknown status as final and leaves no status when there are no citations", async () => {
    const message = await run([{ type: "citations", status: "halfway" }]);
    expect(message.citations).toEqual([]);
    expect(message.citationStatus).toBeUndefined();
  });
});

describe("handler failures", () => {
  it("warns and keeps reading when applying a frame throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    vi.spyOn(turn, "update").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await consumeAssistantTurnStream(
      sseResponse([
        frame(1, { type: "content_delta", text: "a" }),
        frame(2, { type: "content_delta", text: "b" }),
        "data: [DONE]\n\n",
      ]),
      { turn, sink, cursor: createTurnCursor("chat-a") },
    );
    expect(warn).toHaveBeenCalledWith(
      "[useAssistantChat] failed to handle SSE event:",
      { type: "content_delta", text: "a" },
      expect.any(Error),
    );
    expect(turn.turn.assistant.events).toEqual([
      { type: "content", text: "ab", isStreaming: true },
    ]);
    warn.mockRestore();
    turn.finish();
  });
});

describe("readAssistantTurn connection handling", () => {
  /** A response whose body refuses to be cancelled. */
  function unreadableResponse(status: number) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("id: 1\n"));
      },
      cancel() {
        throw new Error("the connection was already gone");
      },
    });
    return new Response(stream, { status });
  }

  it("still reports the status when a rejected response's body cannot be released", async () => {
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    await expect(
      readAssistantTurn({
        open: async () => unreadableResponse(500),
        turn,
        sink,
        cursor: createTurnCursor("chat-a"),
      }),
    ).rejects.toThrow("Chat request failed with status 500");
    turn.finish();
  });

  it("still surfaces the original failure when a rejected resume cannot be released", async () => {
    vi.useFakeTimers();
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    streamChatTurnMock.mockResolvedValueOnce(unreadableResponse(404));
    const read = readAssistantTurn({
      open: async () =>
        sseResponse([frame(1, { type: "chat_id", chatId: "chat-a", turnId: "turn-1" })], {
          fail: true,
        }),
      turn,
      sink,
      cursor: createTurnCursor("chat-a"),
    });
    const outcome = read.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe("network error");
    turn.finish();
  });

  it("gives up on a reconnect when Stop lands during the backoff", async () => {
    vi.useFakeTimers();
    const turn = begin();
    const sink = createTurnEventSink(turn, []);
    const controller = new AbortController();
    const read = readAssistantTurn({
      open: async () =>
        sseResponse([frame(1, { type: "chat_id", chatId: "chat-a", turnId: "turn-1" })], {
          fail: true,
        }),
      turn,
      sink,
      cursor: createTurnCursor("chat-a"),
      signal: controller.signal,
    });
    const outcome = read.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    // Let the first connection drop and the retry backoff start.
    await vi.advanceTimersByTimeAsync(0);
    expect(streamChatTurnMock).not.toHaveBeenCalled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe("network error");
    expect(streamChatTurnMock).not.toHaveBeenCalled();
    turn.finish();
  });
});
