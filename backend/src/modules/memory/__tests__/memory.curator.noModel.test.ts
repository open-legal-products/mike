// handleMemoryConsolidation when the actor has no model the curator may use
// (no key, every provider turned off). It used to throw a plain Error, which
// the queue retried and reported as "Failure in dbq" with nothing to act on
// (MIKE-BACKEND-1Q). Now the job ends quietly as skipped, and the
// conversation is NOT marked processed, so a later turn — once a model is
// available — schedules it again.
//
// Everything the handler reads before model resolution is real except the
// database (an in-memory table fake below) and the four collaborators mocked
// here.

import { describe, expect, it, vi } from "vitest";

const { resolveEffectiveChatModel, getUserModelSettings, ensureMemoryFile, streamChatWithTools } =
  vi.hoisted(() => ({
    resolveEffectiveChatModel: vi.fn(),
    getUserModelSettings: vi.fn(),
    ensureMemoryFile: vi.fn(),
    streamChatWithTools: vi.fn(),
  }));

vi.mock("../../../lib/modelSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/modelSelection")>()),
  resolveEffectiveChatModel,
}));
vi.mock("../../user/user.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../user/user.service")>()),
  getUserModelSettings,
}));
vi.mock("../../../lib/memory/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/memory/files")>()),
  ensureMemoryFile,
}));
vi.mock("../../../lib/wordWorkspace", () => ({
  wordChatHasWorkspaceAttachments: vi.fn(async () => false),
}));
vi.mock("../../../lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/llm")>()),
  streamChatWithTools,
}));

import { handleMemoryConsolidation } from "../memory.curator";

const PAST = "2026-11-01T10:00:00.000Z";

const TABLES: Record<string, Array<Record<string, unknown>>> = {
  memory_consolidation_states: [
    {
      id: "state-1",
      surface: "word",
      conversation_id: "conv-1",
      actor_user_id: "u1",
      project_id: null,
      generation: 2,
      processed_generation: 1,
      latest_turn_id: "a1",
      status: "scheduled",
    },
  ],
  memory_conversation_activity: [{ generation: 5, quiet_until: PAST, deleted_at: null }],
  memory_conversation_turn_leases: [],
  word_chats: [{ id: "conv-1", user_id: "u1", model: "claude-sonnet-5-5" }],
  word_chat_messages: [
    {
      id: "q1",
      role: "user",
      content: "I prefer short answers.",
      author_user_id: "u1",
      memory_input_message_id: null,
      memory_eligible_at: null,
      memory_app_eligible_at: null,
      created_at: "2026-11-01T09:00:00.000Z",
    },
    {
      id: "a1",
      role: "assistant",
      content: "Noted.",
      author_user_id: "u1",
      memory_input_message_id: "q1",
      memory_eligible_at: "2026-11-01T09:00:01.000Z",
      memory_app_eligible_at: "2026-11-01T09:00:01.000Z",
      created_at: "2026-11-01T09:00:01.000Z",
    },
  ],
  memory_files: [{ id: "memory-file", epoch: 1 }],
};

/** A Supabase stand-in: each table's rows, narrowed by the `eq` filters. */
function fakeDb() {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    data: true,
    error: null,
  }));
  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const rows = () =>
      (TABLES[table] ?? []).filter((row) =>
        filters.every(([column, value]) => !(column in row) || row[column] === value),
      );
    const query: Record<string, unknown> = {};
    for (const method of ["select", "gt", "lt", "order", "limit", "update", "in", "not", "is"]) {
      query[method] = vi.fn(() => query);
    }
    query.eq = vi.fn((column: string, value: unknown) => {
      filters.push([column, value]);
      return query;
    });
    query.maybeSingle = vi.fn(async () => ({ data: rows()[0] ?? null, error: null }));
    query.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve);
    return query;
  }
  const db = {
    from: vi.fn(from),
    rpc,
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({ data: { user: { email: "u1@example.com" } }, error: null })),
      },
    },
  };
  return { db, rpc };
}

describe("memory.consolidate with no available model", () => {
  it("skips without retrying, reporting or marking the conversation processed", async () => {
    resolveEffectiveChatModel.mockResolvedValue({ ok: false, reason: "no_available_model" });
    getUserModelSettings.mockResolvedValue({
      api_keys: {},
      last_selected_chat_model: null,
      memory_curator_model: null,
    });
    ensureMemoryFile.mockResolvedValue({
      id: "memory-file",
      scope: "user",
      user_id: "u1",
      project_id: null,
      enabled: true,
      epoch: 1,
      revision: 3,
      learning_cutoff_at: null,
    });
    const { db, rpc } = fakeDb();

    const result = await handleMemoryConsolidation(db as never, {
      id: "job-1",
      kind: "memory.consolidate",
      payload: {
        stateId: "state-1",
        generation: 2,
        conversationGeneration: 5,
        appEpoch: 1,
        sourceEpoch: 1,
        actorUserId: "u1",
      },
    } as never);

    expect(result).toEqual({ skipped: "no_available_model" });
    // It got as far as resolving a model for a real transcript.
    expect(resolveEffectiveChatModel).toHaveBeenCalledTimes(1);
    expect(streamChatWithTools).not.toHaveBeenCalled();
    const statusCalls = rpc.mock.calls.filter(
      ([name]) => name === "set_memory_consolidation_status",
    );
    // Claimed (processing), then released to idle WITHOUT marking the
    // generation processed: the next turn reschedules it.
    expect(statusCalls.map(([, args]) => [args.p_status, args.p_mark_processed])).toEqual([
      ["processing", false],
      ["idle", false],
    ]);
    const fileStatuses = rpc.mock.calls
      .filter(([name]) => name === "refresh_memory_file_status")
      .map(([, args]) => args.p_requested_status);
    expect(fileStatuses.at(-1)).toBe("idle");
  });
});
