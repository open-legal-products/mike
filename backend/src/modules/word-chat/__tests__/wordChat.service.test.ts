// A failed query in the Word chat service reaches the route as an AppError:
// the kind names what broke, the PostgREST object stays the cause, and the
// service itself logs and reports nothing — the route's sendInternalError
// does that once, with the request id. The one post-stream, best-effort
// write (the activity update) is the exception and reports itself.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { AppError } from "../../../lib/appError";

const mocks = vi.hoisted(() => ({
  reportError: vi.fn((..._args: unknown[]) => "event-1"),
}));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportError: mocks.reportError,
}));
vi.mock("../../../lib/wordWorkspace", () => ({
  wordChatHasWorkspaceAttachments: async () => false,
}));
import {
  getWordChatWithMessages,
  listWordChats,
  prepareWordChatStream,
  recordWordChatActivity,
  saveProposedWordEdit,
} from "../wordChat.service";

type Result = { data: unknown; error: unknown };
const ok = (data: unknown): Result => ({ data, error: null });
const pgError = (code: string, message: string) => ({ code, message });

/**
 * A Supabase stub keyed by table: each terminal call on a table consumes the
 * next queued result (the last one repeats), whatever the chain before it.
 */
function makeDb(results: Record<string, Result | Result[]>): Db {
  const next = (table: string): Result => {
    const entry = results[table];
    if (Array.isArray(entry)) {
      return entry.length > 1
        ? (entry.shift() as Result)
        : (entry[0] ?? ok(null));
    }
    return entry ?? ok(null);
  };
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of [
      "select", "insert", "update", "upsert", "delete",
      "eq", "in", "order", "limit", "range",
    ]) q[m] = () => q;
    q.single = () => Promise.resolve(next(table));
    q.maybeSingle = () => Promise.resolve(next(table));
    q.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(next(table)).then(resolve, reject);
    return q;
  };
  return { from: (table: string) => query(table) } as unknown as Db;
}

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

function expectFailure(
  result: { ok: boolean },
  kind: string,
  cause: unknown,
): AppError {
  expect(result.ok).toBe(false);
  const failure = (result as { error?: unknown }).error;
  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).kind).toBe(kind);
  expect((failure as AppError).cause).toBe(cause);
  return failure as AppError;
}

describe("word chat service failures", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("hands the route a word.session_failed error when the document row cannot be read", async () => {
    const cause = pgError("08006", "connection lost");
    const result = await listWordChats(
      makeDb({ word_documents: { data: null, error: cause } }),
      { userId: "u1", clientDocumentId: DOCUMENT_ID, limit: 20, offset: 0 },
    );

    expect(result).toMatchObject({ ok: false, kind: "error" });
    expectFailure(result, "word.session_failed", cause);
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("names a failed message load db.query_failed, keeping the PostgREST code on the cause", async () => {
    const cause = pgError("57014", "statement timeout");
    const result = await getWordChatWithMessages(
      makeDb({
        word_documents: ok({ id: "doc-row-1" }),
        word_chats: ok({ id: CHAT_ID, user_id: "u1" }),
        word_chat_messages: { data: null, error: cause },
      }),
      { userId: "u1", clientDocumentId: DOCUMENT_ID, chatId: CHAT_ID },
    );

    expect(result).toMatchObject({ ok: false, kind: "error" });
    expectFailure(result, "db.query_failed", cause);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns the failed edit upsert as the route's error instead of logging it", async () => {
    const cause = pgError("23503", "foreign key violation");
    const result = await saveProposedWordEdit(
      makeDb({
        word_documents: ok({ id: "doc-row-1" }),
        word_chat_messages: ok({ id: MESSAGE_ID, chat_id: CHAT_ID, role: "assistant" }),
        word_chats: ok({ id: CHAT_ID, user_id: "u1" }),
        word_document_edits: { data: null, error: cause },
      }),
      {
        userId: "u1",
        clientDocumentId: DOCUMENT_ID,
        messageId: MESSAGE_ID,
        blockIndex: 0,
        edit: {
          original_text: "old",
          replacement_text: "new",
          formats: [],
          occurrence: null,
          reason: null,
          apply_mode: "replace" as never,
        },
      },
    );

    expect(result).toMatchObject({ ok: false, kind: "error" });
    expectFailure(result, "db.query_failed", cause);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("answers a failed document upsert before the stream with a 500 that carries its error", async () => {
    const cause = pgError("42P01", 'relation "word_documents" does not exist');
    const result = await prepareWordChatStream(
      makeDb({ word_documents: { data: null, error: cause } }),
      {
        userId: "u1",
        userEmail: "u1@example.test",
        messages: [{ role: "user", content: "Revise this clause" } as never],
        chatId: null,
        clientDocumentId: DOCUMENT_ID,
        activeDocumentName: "Contract.docx",
        documentContext: undefined,
        persistChat: true,
        clientToolsEnabled: false,
        requestedModel: null,
        requestedReasoning: undefined,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      detail: "Failed to initialize Word chat storage",
    });
    expectFailure(result, "word.session_failed", cause);
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports a lost activity update as a warning and still returns null", async () => {
    const cause = pgError("40001", "serialization failure");
    const title = await recordWordChatActivity(
      makeDb({ word_chats: { data: null, error: cause } }),
      {
        persistChat: true,
        chatId: CHAT_ID,
        userId: "u1",
        chatTitle: null,
        lastUserContent: "Revise this clause",
      },
    );

    expect(title).toBeNull();
    expect(mocks.reportError).toHaveBeenCalledOnce();
    const [failure, context] = mocks.reportError.mock.calls[0] as unknown as [
      AppError,
      { level?: string; tags?: Record<string, unknown> },
    ];
    expect(failure).toBeInstanceOf(AppError);
    expect(failure.kind).toBe("db.query_failed");
    expect(failure.cause).toBe(cause);
    expect(context).toMatchObject({ level: "warning", tags: { component: "word-chat" } });
    // The same object is logged, so the console bridge files nothing twice.
    expect(console.error).toHaveBeenCalledWith(
      "[word-chat] failed to update chat activity",
      failure,
    );
  });
});
