import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

type QueryError = { message: string } | null;
type QueryResult = { data: unknown; error: QueryError };
type RecordedQuery = {
  table: string;
  filters: { column: string; value: unknown }[];
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
    "update",
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

vi.mock("../../lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/chat")>();
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

vi.mock("../../lib/userSettings", () => ({
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
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "u1";
    res.locals.userEmail = "u1@test.local";
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
      await import("../../lib/chat/tools/wordClientTools");
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
      await import("../../lib/chat/tools/wordClientTools");
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
    const chatLib = await import("../../lib/chat");
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
