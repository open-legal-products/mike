import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

type QueryError = { message: string } | null;
type QueryResult = { data: unknown; error: QueryError };
type RecordedQuery = {
  table: string;
  filters: { column: string; value: unknown }[];
  /** Which write produced `payload`; a user insert and an assistant update
   *  both carry a `content`, so the two have to be told apart. */
  op?: "insert" | "update";
  payload?: unknown;
};

const { dbState, recordedQueries } = vi.hoisted(() => ({
  dbState: {
    document: { data: { id: "word-document-row-1" }, error: null },
    chatList: { data: [], error: null },
    chatDetail: { data: null, error: null },
    messages: { data: [], error: null },
    messageDetail: { data: null, error: null },
    edits: { data: [], error: null },
    editDetail: { data: null, error: null },
  } as {
    document: QueryResult;
    chatList: QueryResult;
    chatDetail: QueryResult;
    messages: QueryResult;
    messageDetail: QueryResult;
    edits: QueryResult;
    editDetail: QueryResult;
  },
  recordedQueries: [] as RecordedQuery[],
}));

const {
  runLLMStream,
  beginMemoryConversationTurn,
  releaseMemoryConversationTurn,
  scheduleMemoryConsolidation,
} = vi.hoisted(() => ({
  runLLMStream: vi.fn(),
  beginMemoryConversationTurn: vi.fn().mockResolvedValue({
    activityId: "activity-1",
  }),
  releaseMemoryConversationTurn: vi.fn().mockResolvedValue(undefined),
  scheduleMemoryConsolidation: vi.fn().mockResolvedValue({
    job_id: "job-1",
    generation: 1,
  }),
}));

function resultForAwaitedQuery(table: string): QueryResult {
  if (table === "word_chats") return dbState.chatList;
  if (table === "word_chat_messages") return dbState.messages;
  if (table === "word_document_edits") return dbState.edits;
  return { data: null, error: null };
}

function resultForSingleQuery(table: string): QueryResult {
  if (table === "word_documents") return dbState.document;
  if (table === "word_chats") return dbState.chatDetail;
  if (table === "word_chat_messages") return dbState.messageDetail;
  if (table === "word_document_edits") return dbState.editDetail;
  return { data: null, error: null };
}

function makeQuery(table: string) {
  const recorded: RecordedQuery = { table, filters: [] };
  recordedQueries.push(recorded);

  const query: Record<string, unknown> = {};
  const chain = [
    "select",
    "delete",
    "upsert",
    "neq",
    "in",
    "is",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "filter",
    "order",
    "limit",
    "range",
    "contains",
  ];
  for (const method of chain) query[method] = vi.fn(() => query);
  query.insert = vi.fn((payload: unknown) => {
    recorded.op = "insert";
    recorded.payload = payload;
    return query;
  });
  // What a turn WRITES BACK into its reserved assistant row is as much a part
  // of the contract as what it inserted, and only recording it can show it.
  query.update = vi.fn((payload: unknown) => {
    recorded.op = "update";
    recorded.payload = payload;
    return query;
  });
  query.eq = vi.fn((column: string, value: unknown) => {
    recorded.filters.push({ column, value });
    return query;
  });
  query.single = vi.fn(() => Promise.resolve(resultForSingleQuery(table)));
  query.maybeSingle = vi.fn(() => Promise.resolve(resultForSingleQuery(table)));
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(resultForAwaitedQuery(table)).then(resolve, reject);
  return query;
}

function mockSupabase() {
  return {
    from: vi.fn((table: string) => makeQuery(table)),
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
    },
  };
}

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => mockSupabase()),
}));

vi.mock("../../lib/memory/schedule", () => ({
  beginMemoryConversationTurn: (...args: unknown[]) =>
    beginMemoryConversationTurn(...args),
  releaseMemoryConversationTurn: (...args: unknown[]) =>
    releaseMemoryConversationTurn(...args),
  scheduleMemoryConsolidation: (...args: unknown[]) =>
    scheduleMemoryConsolidation(...args),
}));

vi.mock("../../modules/chat/engine/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/chat/engine/index")>();
  return {
    ...actual,
    buildDocContext: vi.fn(async () => ({
      docIndex: {},
      docStore: new Map(),
    })),
    enrichWithPriorEvents: vi.fn(async (messages: unknown) => messages),
    buildWorkflowStore: vi.fn(async () => new Map()),
    buildMessages: vi.fn(() => []),
    runLLMStream: (...args: unknown[]) => runLLMStream(...args),
  };
});

vi.mock("../../modules/user/user.settings", () => ({
  getUserModelSettings: vi.fn(async () => ({
    legal_research_us: false,
    title_model: "test-model",
    tabular_model: "test-model",
    last_selected_chat_model: null,
    last_selected_reasoning_level: null,
    api_keys: { gemini: "test-key" },
    personalisation: null,
  })),
  persistLastSelectedChatModel: vi.fn(async () => null),
  persistLastSelectedReasoningLevel: vi.fn(async () => null),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    req: { headers?: Record<string, unknown> },
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    // Default u1; `x-test-user` lets one suite play a second account without
    // a second app instance.
    const asUser =
      typeof req?.headers?.["x-test-user"] === "string"
        ? (req.headers["x-test-user"] as string)
        : "u1";
    res.locals.userId = asUser;
    res.locals.userEmail = `${asUser}@test.local`;
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import { app } from "../../app";

const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHAT_ID = "41eb8f61-d7af-454e-b680-cd28bd65c742";
const MESSAGE_ID = "efca16cc-daca-40ef-83cb-1e974582691c";
const AUTH = ["Authorization", "Bearer test"] as const;

function resetDbState() {
  dbState.document = {
    data: { id: "word-document-row-1" },
    error: null,
  };
  dbState.chatList = { data: [], error: null };
  dbState.chatDetail = { data: null, error: null };
  dbState.messages = { data: [], error: null };
  dbState.messageDetail = { data: null, error: null };
  dbState.edits = { data: [], error: null };
  dbState.editDetail = { data: null, error: null };
}

describe("Word chat history routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedQueries.length = 0;
    resetDbState();
  });

  it("returns an empty list when the document row genuinely does not exist", async () => {
    dbState.document = { data: null, error: null };

    const res = await request(app)
      .get(`/word-chat?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(recordedQueries.map(({ table }) => table)).toEqual([
      "word_documents",
    ]);
  });

  it("returns 500 when the document lookup query fails", async () => {
    dbState.document = {
      data: null,
      error: { message: "word_documents is unavailable" },
    };

    const res = await request(app)
      .get(`/word-chat?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
    expect(recordedQueries.map(({ table }) => table)).toEqual([
      "word_documents",
    ]);
  });

  it("returns 500 when the document-scoped chat list query fails", async () => {
    dbState.chatList = {
      data: null,
      error: { message: "word_chats is unavailable" },
    };

    const res = await request(app)
      .get(`/word-chat?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
  });

  it("returns 500 rather than 404 when a detail document lookup fails", async () => {
    dbState.document = {
      data: null,
      error: { message: "document lookup failed" },
    };

    const res = await request(app)
      .get(`/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
  });

  it("returns 500 rather than 404 when the scoped chat lookup fails", async () => {
    dbState.chatDetail = {
      data: null,
      error: { message: "chat lookup failed" },
    };

    const res = await request(app)
      .get(`/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
    expect(
      recordedQueries.find(({ table }) => table === "word_chats")?.filters,
    ).toEqual([
      { column: "id", value: CHAT_ID },
      { column: "word_document_id", value: "word-document-row-1" },
      { column: "user_id", value: "u1" },
    ]);
    expect(
      recordedQueries.some(({ table }) => table === "word_chat_messages"),
    ).toBe(false);
  });

  it("keeps a genuinely missing scoped chat as 404", async () => {
    const res = await request(app)
      .get(`/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Chat not found");
  });

  it("hydrates normalized edits alongside their assistant message", async () => {
    dbState.chatDetail = {
      data: {
        id: CHAT_ID,
        user_id: "u1",
        word_document_id: "word-document-row-1",
      },
      error: null,
    };
    dbState.messages = {
      data: [
        {
          id: MESSAGE_ID,
          chat_id: CHAT_ID,
          role: "assistant",
          content: [{ type: "word_edit_ref", edit_id: "edit-1" }],
        },
      ],
      error: null,
    };
    dbState.edits = {
      data: [
        {
          id: "edit-1",
          word_chat_message_id: MESSAGE_ID,
          block_index: 0,
          original_text: "ten days",
          replacement_text: "five days",
        },
      ],
      error: null,
    };

    const res = await request(app)
      .get(`/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.messages[0].edits).toEqual(dbState.edits.data);
  });

  it("returns 404 before querying Postgres for a malformed chat id", async () => {
    const res = await request(app)
      .get(`/word-chat/not-a-uuid?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Chat not found");
    expect(recordedQueries).toEqual([]);
  });

  it("idempotently stores a normalized edit for the authenticated document", async () => {
    dbState.messageDetail = {
      data: { id: MESSAGE_ID, chat_id: CHAT_ID, role: "assistant" },
      error: null,
    };
    dbState.chatDetail = {
      data: {
        id: CHAT_ID,
        user_id: "u1",
        word_document_id: "word-document-row-1",
      },
      error: null,
    };
    dbState.editDetail = {
      data: {
        id: "edit-1",
        word_chat_message_id: MESSAGE_ID,
        block_index: 0,
      },
      error: null,
    };
    const res = await request(app)
      .put(
        `/word-chat/messages/${MESSAGE_ID}/edits/0?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({
        original_text: "ten days",
        replacement_text: "five days",
        formats: [],
        reason: "Shortens the cure period",
        apply_mode: "approval",
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("edit-1");
    expect(recordedQueries.map(({ table }) => table)).toContain(
      "word_document_edits",
    );
  });

  it("rejects malformed normalized edits before querying their message", async () => {
    const res = await request(app)
      .put(
        `/word-chat/messages/${MESSAGE_ID}/edits/0?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({ original_text: "", apply_mode: "approval" });

    expect(res.status).toBe(400);
    expect(recordedQueries).toEqual([]);
  });

  it("rejects normalized edit anchors longer than the Word protocol limit", async () => {
    const res = await request(app)
      .put(
        `/word-chat/messages/${MESSAGE_ID}/edits/0?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({
        original_text: "x".repeat(201),
        replacement_text: "replacement",
        formats: [],
        apply_mode: "approval",
      });

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe(
      "original_text must be at most 200 characters",
    );
    expect(recordedQueries).toEqual([]);
  });

  it("does not reveal a normalized edit target outside the document scope", async () => {
    dbState.messageDetail = {
      data: { id: MESSAGE_ID, chat_id: CHAT_ID, role: "assistant" },
      error: null,
    };

    const res = await request(app)
      .patch(
        `/word-chat/messages/${MESSAGE_ID}/edits/0?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({ resolution_status: "accepted" });

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Message not found");
  });
});

describe("POST /word-chat/tool-result", () => {
  const TOOL_CALL_ID = "7f0e19cf-9be0-4b53-a1c4-2f2ffb92e611";

  it("rejects a malformed tool_call_id", async () => {
    const res = await request(app)
      .post("/word-chat/tool-result")
      .set(...AUTH)
      .send({ tool_call_id: "not-a-uuid", result: {} });

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("tool_call_id must be a UUID");
  });

  it("answers 404 for an unknown or expired call id", async () => {
    const res = await request(app)
      .post("/word-chat/tool-result")
      .set(...AUTH)
      .send({ tool_call_id: TOOL_CALL_ID, result: {} });

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Unknown or expired tool call");
  });

  it("delivers a pending call's result to the awaiting stream", async () => {
    const { waitForClientToolResult } =
      await import("../../modules/chat/engine/tools/wordClientTools.js");
    const pending = waitForClientToolResult({
      callId: TOOL_CALL_ID,
      userId: "u1",
    });

    const res = await request(app)
      .post("/word-chat/tool-result")
      .set(...AUTH)
      .send({
        tool_call_id: TOOL_CALL_ID,
        result: { edits: [{ index: 0, status: "proposed" }] },
      });

    expect(res.status).toBe(204);
    await expect(pending).resolves.toEqual({
      edits: [{ index: 0, status: "proposed" }],
    });
  });

  it("does not deliver results across users", async () => {
    const { waitForClientToolResult, submitClientToolResult } =
      await import("../../modules/chat/engine/tools/wordClientTools.js");
    const pending = waitForClientToolResult({
      callId: TOOL_CALL_ID,
      userId: "someone-else",
    });

    // The mocked auth middleware authenticates as u1; the pending call
    // belongs to someone-else, so delivery must be refused as if unknown.
    const res = await request(app)
      .post("/word-chat/tool-result")
      .set(...AUTH)
      .send({ tool_call_id: TOOL_CALL_ID, result: {} });

    expect(res.status).toBe(404);
    // Settle the pending promise so the test leaves no dangling timer.
    submitClientToolResult(TOOL_CALL_ID, "someone-else", {});
    await pending;
  });
});

describe("POST /word-chat — local storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedQueries.length = 0;
    resetDbState();
    runLLMStream.mockResolvedValue({
      events: [{ type: "content", text: "Response" }],
      citations: [],
    });
  });

  it("does not schedule memory consolidation without a durable transcript", async () => {
    const res = await request(app)
      .post("/word-chat")
      .set(...AUTH)
      .send({
        messages: [{ role: "user", content: "Revise this clause" }],
        document_id: DOCUMENT_ID,
        document_name: "Contract.docx",
        storage: "local",
        model: "gemini-3-flash-preview",
      });

    expect(res.status).toBe(200);
    expect(runLLMStream).toHaveBeenCalledTimes(1);
    expect(beginMemoryConversationTurn).not.toHaveBeenCalled();
    expect(scheduleMemoryConsolidation).not.toHaveBeenCalled();
  });

  it("schedules memory after a durable cloud turn", async () => {
    const chatLib = await import("../../modules/chat/engine/index.js");
    dbState.chatDetail = {
      data: { id: CHAT_ID, title: null, user_id: "u1" },
      error: null,
    };

    const res = await request(app)
      .post("/word-chat")
      .set(...AUTH)
      .send({
        messages: [{ role: "user", content: "Revise this clause" }],
        document_id: DOCUMENT_ID,
        document_name: "Contract.docx",
        storage: "cloud",
        model: "gemini-3-flash-preview",
      });

    expect(res.status).toBe(200);
    expect(beginMemoryConversationTurn).toHaveBeenCalledWith({
      db: expect.anything(),
      surface: "word",
      conversationId: CHAT_ID,
      actorUserId: "u1",
    });
    const userInsert = recordedQueries.find(
      ({ table, payload }) =>
        table === "word_chat_messages" &&
        (payload as { role?: unknown } | undefined)?.role === "user",
    );
    const assistantInsert = recordedQueries.find(
      ({ table, payload }) =>
        table === "word_chat_messages" &&
        (payload as { role?: unknown } | undefined)?.role === "assistant",
    );
    const inputMessageId = (
      userInsert?.payload as { id?: string } | undefined
    )?.id;
    expect(inputMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(assistantInsert?.payload).toMatchObject({
      author_user_id: "u1",
      memory_input_message_id: inputMessageId,
    });
    expect(
      beginMemoryConversationTurn.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(chatLib.buildDocContext).mock.invocationCallOrder[0],
    );
    expect(scheduleMemoryConsolidation).toHaveBeenCalledWith({
      db: expect.anything(),
      surface: "word",
      conversationId: CHAT_ID,
      actorUserId: "u1",
      projectId: null,
      turnId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      turn: { activityId: "activity-1" },
    });
    expect(releaseMemoryConversationTurn).not.toHaveBeenCalled();
  });

  it("releases the cloud turn lease when the model fails", async () => {
    dbState.chatDetail = {
      data: { id: CHAT_ID, title: null, user_id: "u1" },
      error: null,
    };
    runLLMStream.mockRejectedValueOnce(new Error("provider failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/word-chat")
      .set(...AUTH)
      .send({
        messages: [{ role: "user", content: "Revise this clause" }],
        document_id: DOCUMENT_ID,
        document_name: "Contract.docx",
        storage: "cloud",
        model: "gemini-3-flash-preview",
      });

    expect(res.status).toBe(200);
    expect(releaseMemoryConversationTurn).toHaveBeenCalledWith({
      db: expect.anything(),
      surface: "word",
      conversationId: CHAT_ID,
      turn: { activityId: "activity-1" },
    });
    expect(scheduleMemoryConsolidation).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The answer belongs to the server, not to the task pane's socket: closing
// the pane detaches, only the stop endpoint cancels, and a pane that reopens
// attaches and replays — including a client tool call still waiting on it.
// ---------------------------------------------------------------------------
describe("server-owned Word turns", () => {
  type StreamParams = {
    write: (s: string) => void;
    signal?: AbortSignal;
    clientTools?: {
      execute: (call: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }) => Promise<{ content: string; events: unknown[] }>;
    };
  };
  const emitFrom = (params: StreamParams) => (frame: object) =>
    params.write(`data: ${JSON.stringify(frame)}\n\n`);
  const records = (text: string) =>
    text.split("\n\n").filter((record) => record.includes("data: "));

  const OTHER_DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174999";

  const send = (body: Record<string, unknown> = {}) =>
    request(app)
      .post("/word-chat")
      .set(...AUTH)
      .send({
        messages: [{ role: "user", content: "Revise this clause" }],
        document_id: DOCUMENT_ID,
        document_name: "Contract.docx",
        storage: "cloud",
        chat_id: CHAT_ID,
        model: "gemini-3-flash-preview",
        ...body,
      });

  /** A generation the test releases by hand. */
  function heldGeneration() {
    const held = {
      release: () => {},
      started: new Promise<StreamParams>((resolve) => {
        runLLMStream.mockImplementation(async (raw: unknown) => {
          const params = raw as StreamParams;
          resolve(params);
          emitFrom(params)({ type: "content_delta", text: "First" });
          await new Promise<void>((done) => {
            held.release = done;
          });
          emitFrom(params)({ type: "content_delta", text: " second" });
          return {
            events: [{ type: "content", text: "First second" }],
            citations: [],
          };
        });
      }),
    };
    return held;
  }

  const assistantUpdate = () =>
    recordedQueries.find(
      ({ table, op }) => table === "word_chat_messages" && op === "update",
    )?.payload as { content?: unknown } | undefined;

  const detail = () =>
    request(app)
      .get(`/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

  beforeEach(async () => {
    vi.clearAllMocks();
    recordedQueries.length = 0;
    resetDbState();
    dbState.chatDetail = {
      data: {
        id: CHAT_ID,
        title: null,
        user_id: "u1",
        word_document_id: "word-document-row-1",
      },
      error: null,
    };
    const { resetAssistantTurnRunsForTests } = await import(
      "../../lib/assistantTurnRuns.js"
    );
    resetAssistantTurnRunsForTests();
  });

  it("keeps generating after the pane's socket closes, and a reopen attaches from where it left off", async () => {
    const held = heldGeneration();
    const first = send();
    const firstSettled = first.then(
      () => "ended",
      () => "aborted",
    );
    const params = await held.started;

    // The pane closes (Word reloads it, the user hides it, the link drops).
    first.abort();
    expect(await firstSettled).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(params.signal?.aborted).toBe(false);

    // What a reopened pane sees: the transcript plus the live turn. The
    // reserved assistant row is filtered out of `messages`, so the answer is
    // only there as `active_turn`.
    const loaded = await detail();
    expect(loaded.status).toBe(200);
    const turnId = loaded.body.active_turn.id as string;
    expect(loaded.body.active_turn.assistant_message_id).toBe(turnId);
    expect(loaded.body.active_turn.seq).toBeGreaterThanOrEqual(2);
    expect(loaded.body.messages).toEqual([]);

    const tail = request(app)
      .get(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stream?document_id=${DOCUMENT_ID}&from=2`,
      )
      .set(...AUTH);
    setTimeout(() => held.release(), 30);
    const resumed = await tail;
    expect(resumed.status).toBe(200);
    expect(resumed.headers["content-type"]).toContain("text/event-stream");
    const lines = records(resumed.text);
    expect(lines[0]).toBe(
      'id: 2\ndata: {"type":"content_delta","text":"First"}',
    );
    expect(resumed.text).toContain('"text":" second"');
    expect(resumed.text).toContain("data: [DONE]");
    expect(resumed.text).not.toContain('"type":"chat_id"');
    expect(resumed.text).not.toContain('"type":"cancelled"');

    // The whole answer was stored; nothing was cancelled.
    expect(assistantUpdate()).toMatchObject({
      content: [{ type: "content", text: "First second" }],
    });
    expect((await detail()).body.active_turn).toBeNull();
  });

  it("stops a turn through the endpoint: readers see cancelled then [DONE], the partial answer is stored", async () => {
    const { AssistantStreamAbortError } = await import(
      "../../modules/chat/engine/index.js"
    );
    const started = new Promise<StreamParams>((resolve) => {
      runLLMStream.mockImplementation(async (raw: unknown) => {
        const params = raw as StreamParams;
        resolve(params);
        emitFrom(params)({ type: "content_delta", text: "Partial" });
        await new Promise<void>((done) =>
          params.signal?.addEventListener("abort", () => done(), {
            once: true,
          }),
        );
        throw new AssistantStreamAbortError("Partial", [
          { type: "content", text: "Partial" },
        ]);
      });
    });
    const first = send();
    const firstDone = first.then((res) => res);
    const params = await started;
    const turnId = (await detail()).body.active_turn.id as string;

    const stopped = await request(app)
      .post(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stop?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ stopped: true, finished: false });
    expect(params.signal?.aborted).toBe(true);

    const text = (await firstDone).text;
    expect(text).toContain(`"turnId":"${turnId}"`);
    expect(text).toContain('"type":"cancelled"');
    expect(text).toContain("data: [DONE]");
    expect(assistantUpdate()).toMatchObject({
      content: [
        { type: "content", text: "Partial" },
        { type: "content", text: "Cancelled by user." },
      ],
    });

    const again = await request(app)
      .post(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stop?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH);
    expect(again.body).toEqual({ stopped: false, finished: true });
  });

  it("refuses a second turn while one is generating into the chat", async () => {
    const held = heldGeneration();
    const first = send();
    const firstDone = first.then((res) => res);
    await held.started;

    const second = await send();
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      code: "turn_in_progress",
      detail: "A response is already being generated for this chat.",
    });

    held.release();
    expect((await firstDone).text).toContain("data: [DONE]");
    expect(runLLMStream).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for another user, another document, and an unknown turn", async () => {
    const held = heldGeneration();
    const first = send();
    const firstDone = first.then((res) => res);
    await held.started;
    const turnId = (await detail()).body.active_turn.id as string;

    // A local Word chat has no server row to authorise against, so the run
    // itself is the authority: whose it is, and which document it belongs to.
    const foreign = await request(app)
      .get(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stream?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .set("x-test-user", "u2");
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("turn_not_found");

    const otherDocument = await request(app)
      .post(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stop?document_id=${OTHER_DOCUMENT_ID}`,
      )
      .set(...AUTH);
    expect(otherDocument.status).toBe(404);

    const unknown = await request(app)
      .get(
        `/word-chat/${CHAT_ID}/turn/not-a-turn/stream?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH);
    expect(unknown.status).toBe(404);

    held.release();
    await firstDone;
  });

  it("owns a LOCAL chat's turn too, authorising the resume from the run alone", async () => {
    const held = heldGeneration();
    // `storage: "local"` is the user asking that this conversation NOT be
    // kept server-side: nothing is persisted, so there is no row a resume
    // could be authorised against — only the run.
    const first = send({ storage: "local" });
    const firstSettled = first.then(
      () => "ended",
      () => "aborted",
    );
    const params = await held.started;
    expect(
      (params as unknown as { conversationId?: string | null }).conversationId,
    ).toBeNull();
    const turnId = (await detail()).body.active_turn.id as string;

    first.abort();
    expect(await firstSettled).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(params.signal?.aborted).toBe(false);

    // Take the chat row away entirely: the stream endpoint must not look at
    // one, or a local chat could never reattach.
    dbState.chatDetail = { data: null, error: null };
    const tail = request(app)
      .get(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stream?document_id=${DOCUMENT_ID}&from=1`,
      )
      .set(...AUTH);
    setTimeout(() => held.release(), 30);
    const resumed = await tail;
    expect(resumed.status).toBe(200);
    expect(resumed.text).toContain('"text":"First"');
    expect(resumed.text).toContain('"text":" second"');
    expect(resumed.text).toContain("data: [DONE]");
    // Nothing was written to the transcript, local meaning local. (The
    // detail read above is this suite's way of learning the turn id; the
    // pane learns it from the `chat_id` frame.)
    expect(
      recordedQueries.some(
        ({ table, op }) => table === "word_chat_messages" && op !== undefined,
      ),
    ).toBe(false);
  });

  it("replays a client tool call that is still pending, but not one that has settled", async () => {
    let forwarded!: Promise<unknown>;
    const started = new Promise<StreamParams>((resolve) => {
      runLLMStream.mockImplementation(async (raw: unknown) => {
        const params = raw as StreamParams;
        forwarded = params.clientTools!.execute({
          id: "tool-1",
          name: "read_active_document",
          arguments: {},
        });
        resolve(params);
        await forwarded;
        return {
          events: [{ type: "content", text: "Read it" }],
          citations: [],
        };
      });
    });
    const first = send({ client_tools: true });
    const firstDone = first.then((res) => res);
    await started;
    const turnId = (await detail()).body.active_turn.id as string;

    // A pane that reattaches while the call is OUTSTANDING is handed it
    // again — that is how a pane closed mid-call can still answer it.
    // `.end()`, not `await`: superagent only dispatches when the request is
    // consumed, and this one has to be ATTACHED before the call settles —
    // that is the whole point of the assertion below.
    const attachRequest = request(app)
      .get(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stream?document_id=${DOCUMENT_ID}&from=1`,
      )
      .set(...AUTH);
    const attached = new Promise<{ text: string }>((resolve, reject) => {
      attachRequest.end((error, res) => (error ? reject(error) : resolve(res)));
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await request(app)
      .post(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stop?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH);

    const pendingReplay = await attached;
    expect(pendingReplay.text).toContain('"type":"client_tool_call"');
    await firstDone;

    // The stop settled the call. Attaching again — the run is retained for a
    // late reader — must NOT hand it out a second time: executing it twice
    // would read (or edit) the document twice.
    const settledReplay = await request(app)
      .get(
        `/word-chat/${CHAT_ID}/turn/${turnId}/stream?document_id=${DOCUMENT_ID}&from=1`,
      )
      .set(...AUTH);
    expect(settledReplay.status).toBe(200);
    expect(settledReplay.text).toContain('"type":"chat_id"');
    expect(settledReplay.text).not.toContain('"type":"client_tool_call"');
    // The keep-alive comments the adapter wrote while the call was
    // outstanding were never buffered, so they cannot be replayed either.
    expect(settledReplay.text).not.toContain("tool-wait");
  });
});
