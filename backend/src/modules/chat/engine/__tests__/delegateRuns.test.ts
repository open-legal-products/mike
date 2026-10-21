import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/access", () => ({
  filterAccessibleDocumentIds: vi.fn(async () => ["doc-a"]),
}));

import {
  REMOVED_RESULT,
  createSubagentRunStore,
  toolRecord,
  type SubagentTranscript,
} from "../tools/delegateRuns";

const record = (tool: string, documents: { document_id: string; version_id: string | null }[]) => ({
  tool,
  input: "{}",
  result: `${tool} result`,
  documents,
});

const transcript: SubagentTranscript = {
  v: 1,
  title: "Lease review",
  task: "Summarise the lease.",
  text: "Rent rises yearly.",
  effort: "standard",
  tier: "standard",
  omitted: 0,
  records: [
    record("read_document", [{ document_id: "doc-a", version_id: "v1" }]),
    record("read_document", [{ document_id: "doc-b", version_id: "v2" }]),
    record("find_documents", []),
    record("web_search", []),
  ],
};

function db(row: Record<string, unknown> = { transcript }, messageContent: unknown[] = []) {
  const filters: unknown[][] = [];
  const query = (result: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gt", "in"]) {
      chain[method] = vi.fn((...args: unknown[]) => {
        filters.push([method, ...args]);
        return method === "in" ? Promise.resolve(result) : chain;
      });
    }
    chain.maybeSingle = vi.fn(async () => result);
    return chain;
  };
  return {
    filters,
    client: {
      from: (table: string) =>
        table === "document_versions"
          ? query({ data: [{ id: "v1" }, { id: "v2" }], error: null })
          : table === "chat_messages"
            ? query({ data: { content: messageContent }, error: null })
            : query({ data: row, error: null }),
    } as never,
  };
}

describe("subagent run store", () => {
  it("loads only the user's unexpired run in this chat, without documents they can no longer open", async () => {
    const { client, filters } = db();
    const store = createSubagentRunStore({
      db: client,
      userId: "user-1",
      chatId: "chat-1",
      messageId: "message-1",
    });

    const loaded = await store.load("delegation-1");

    expect(filters).toEqual(
      expect.arrayContaining([
        ["eq", "chat_id", "chat-1"],
        ["eq", "user_id", "user-1"],
        ["eq", "delegation_id", "delegation-1"],
        ["gt", "expires_at", expect.any(String)],
      ]),
    );
    expect(loaded?.records.map((r) => [r.tool, r.result])).toEqual([
      ["read_document", "read_document result"],
      ["read_document", REMOVED_RESULT],
      ["web_search", "web_search result"],
    ]);
  });

  it("tells a run that waited on approvals what became of each, from its answer's saved events", async () => {
    const approval = (id: string, title: string) => ({
      id,
      kind: "approval",
      connector_name: "Mail",
      title,
    });
    const { client } = db(
      {
        transcript: { ...transcript, approval_ids: ["sent", "bounced", "refused", "unknown"] },
        message_id: "message-1",
      },
      [
        {
          type: "ask_inputs",
          event_id: "e1",
          items: ["sent", "bounced", "refused", "unknown"].map((id) => approval(id, `Send ${id}`)),
        },
        {
          type: "ask_inputs_response",
          responses: [
            { id: "sent", kind: "approval", decision: "approve" },
            { id: "bounced", kind: "approval", decision: "approve" },
            { id: "refused", kind: "approval", decision: "reject" },
            { id: "unknown", kind: "approval", decision: "approve" },
          ],
        },
        { type: "mcp_tool_call", approval_id: "sent", status: "ok", result: "queued" },
        { type: "mcp_tool_call", approval_id: "bounced", status: "error" },
      ],
    );
    const store = createSubagentRunStore({
      db: client,
      userId: "user-1",
      chatId: "chat-1",
      messageId: "message-2",
    });

    const loaded = await store.load("delegation-1");

    expect(loaded?.approvalOutcomes).toEqual([
      expect.stringMatching(/approved and ran.*queued/),
      expect.stringMatching(/failed/),
      expect.stringMatching(/rejected/),
      expect.stringMatching(/no recorded outcome/),
    ]);
  });

  it("records the documents a call names by label, filename or id, or none if one is unknown", () => {
    const docStore = new Map([["doc-0", { storage_path: "", file_type: "pdf", filename: "lease.pdf" }]]);
    const docIndex = {
      "doc-0": { document_id: "doc-a", filename: "lease.pdf", version_id: "v1" },
      "doc-1": { document_id: "doc-b", filename: "deed.pdf" },
    };
    const call = (doc_ids: string[]) => ({ id: "c", name: "fetch_documents", input: { doc_ids } });

    expect(toolRecord(call(["lease.pdf", "doc-b"]), "", docStore, docIndex).documents).toEqual([
      { document_id: "doc-a", version_id: "v1" },
      { document_id: "doc-b", version_id: null },
    ]);
    expect(toolRecord(call(["doc-0", "unknown.pdf"]), "", docStore, docIndex).documents).toEqual([]);
  });
});
