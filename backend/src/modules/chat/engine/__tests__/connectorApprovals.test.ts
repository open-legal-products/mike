import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalItem } from "@mike/contracts";

const mocks = vi.hoisted(() => ({
  google: vi.fn(),
  mcp: vi.fn(),
}));
vi.mock("../../../../lib/integrations/googleWorkspace", async (original) => ({
  ...(await original<
    typeof import("../../../../lib/integrations/googleWorkspace")
  >()),
  executeApprovedGoogleWorkspaceCall: mocks.google,
}));
vi.mock("../../../../lib/mcpConnectors", async (original) => ({
  ...(await original<typeof import("../../../../lib/mcpConnectors")>()),
  executeApprovedMcpToolCall: mocks.mcp,
}));

import {
  appendAskInputsResponseToAssistantMessage,
  enrichWithPriorEvents,
  parseAskInputsResponsePayload,
} from "../contextBuilders";
import {
  MAX_APPROVAL_RESULT_CHARS,
  runApprovedConnectorActions,
} from "../tools/connectorApprovals";

const gmailItem: ConnectorApprovalItem = {
  id: "approve-gmail",
  kind: "approval",
  connector_name: "Gmail",
  tool_name: "gmail_send",
  title: "Send email",
  arguments: { to: ["a@example.com"], subject: "Hi", body: "Body" },
  account: "me@example.com",
  binding: { type: "google", provider: "gmail", grant_id: "g1" },
};
const slackItem: ConnectorApprovalItem = {
  id: "approve-slack",
  kind: "approval",
  connector_name: "Slack",
  tool_name: "mcp_slack_post",
  title: "Post message",
  arguments: { channel: "general", text: "hi" },
  binding: { type: "mcp", connector_id: "c1", tool_id: "t1" },
};

/** One assistant row whose events the RPCs append to, like chat_messages. */
function messageDb(content: Record<string, unknown>[]) {
  const row = {
    id: "assistant-1",
    chat_id: "chat-1",
    role: "assistant",
    content,
    citations: null,
    author_user_id: "user-1",
    created_at: "2026-01-01T00:00:00Z",
  };
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [row], error: null }).then(resolve),
      };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "append_chat_ask_inputs_response")
        row.content = [...row.content, args.p_response as never];
      if (name === "append_chat_assistant_events")
        row.content = [...row.content, ...(args.p_events as never[])];
      return { data: "appended", error: null };
    },
  };
  return { db: db as never, row, rpcCalls };
}

const askEvent = {
  type: "ask_inputs",
  event_id: "ask-1",
  items: [gmailItem, slackItem],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approval responses", () => {
  it("carries only the decision from the client", () => {
    expect(
      parseAskInputsResponsePayload({
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [
          {
            id: "approve-gmail",
            kind: "approval",
            decision: "approve",
            arguments: { to: ["attacker@example.com"] },
          },
          { id: "approve-slack", kind: "approval", decision: "maybe" },
        ],
      }),
    ).toEqual({
      assistant_message_id: "assistant-1",
      ask_event_id: "ask-1",
      responses: [{ id: "approve-gmail", kind: "approval", decision: "approve" }],
    });
  });

  it("rejects a decision that does not match a pending approval item", async () => {
    const { db } = messageDb([
      {
        type: "ask_inputs",
        event_id: "ask-1",
        items: [
          { id: "q", kind: "text", question: "Why?" },
          gmailItem,
        ],
      },
    ]);
    expect(
      await appendAskInputsResponseToAssistantMessage(
        db,
        "chat-1",
        {
          assistant_message_id: "assistant-1",
          ask_event_id: "ask-1",
          responses: [
            { id: "q", kind: "approval", decision: "approve" },
            { id: "approve-gmail", kind: "approval", decision: "approve" },
          ],
        },
        "user-1",
      ),
    ).toBe("invalid");
  });
});

describe("runApprovedConnectorActions", () => {
  it("runs only approved items, from the persisted event, and appends bounded results", async () => {
    const { db, row, rpcCalls } = messageDb([askEvent]);
    expect(
      await appendAskInputsResponseToAssistantMessage(
        db,
        "chat-1",
        {
          assistant_message_id: "assistant-1",
          ask_event_id: "ask-1",
          responses: [
            { id: "approve-gmail", kind: "approval", decision: "approve" },
            { id: "approve-slack", kind: "approval", decision: "reject" },
          ],
        },
        "user-1",
      ),
    ).toBe("appended");
    mocks.google.mockResolvedValue({
      content: "x".repeat(MAX_APPROVAL_RESULT_CHARS + 50),
      event: {
        type: "mcp_tool_call",
        connector_id: "gmail-native",
        connector_name: "Gmail",
        tool_name: "gmail_send",
        openai_tool_name: "gmail_send",
        status: "ok",
        approval_id: "approve-gmail",
      },
    });

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(mocks.google).toHaveBeenCalledOnce();
    expect(mocks.google).toHaveBeenCalledWith("user-1", gmailItem, db);
    expect(mocks.mcp).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      approval_id: "approve-gmail",
      status: "ok",
    });
    expect(events[0].result).toHaveLength(MAX_APPROVAL_RESULT_CHARS);
    expect(rpcCalls.map((call) => call.name)).toEqual([
      "append_chat_ask_inputs_response",
      "append_chat_assistant_events",
    ]);
    expect(row.content.at(-1)).toMatchObject({ approval_id: "approve-gmail" });
  });

  it("runs nothing when there is no recorded decision", async () => {
    const { db } = messageDb([askEvent]);
    expect(
      await runApprovedConnectorActions({
        db,
        chatId: "chat-1",
        messageId: "assistant-1",
        askEventId: "ask-1",
        userId: "user-1",
      }),
    ).toEqual([]);
    expect(mocks.google).not.toHaveBeenCalled();
    expect(mocks.mcp).not.toHaveBeenCalled();
  });
});

describe("approval context replay", () => {
  it("tells the model what was approved, what ran, what was rejected, and what has no outcome", async () => {
    const calendarItem = {
      ...gmailItem,
      id: "approve-calendar",
      connector_name: "Google Calendar",
      tool_name: "google_calendar_create_event",
    };
    const { db } = messageDb([
      { ...askEvent, items: [gmailItem, slackItem, calendarItem] },
      {
        type: "ask_inputs_response",
        ask_event_id: "ask-1",
        responses: [
          { id: "approve-gmail", kind: "approval", decision: "approve" },
          { id: "approve-slack", kind: "approval", decision: "reject" },
          { id: "approve-calendar", kind: "approval", decision: "approve" },
        ],
      },
      {
        type: "mcp_tool_call",
        connector_id: "gmail-native",
        connector_name: "Gmail",
        tool_name: "gmail_send",
        openai_tool_name: "gmail_send",
        status: "ok",
        approval_id: "approve-gmail",
        result: '{"ok":true,"data":{"id":"sent-1"}}',
      },
    ]);

    const [assistant] = await enrichWithPriorEvents(
      [
        { role: "assistant", content: "I'll send that." },
        { role: "user", content: "Approved." },
      ],
      "chat-1",
      db,
      {},
      "nonce1234",
    );
    const text = assistant.content ?? "";
    expect(text).not.toContain("asked user for");
    expect(text).toMatch(/user approved .*gmail_send/s);
    expect(text).toMatch(/approved .*gmail_send.* completed; result: .*sent-1/s);
    expect(text).toMatch(/user rejected .*mcp_slack_post.*did not run/s);
    expect(text).toMatch(
      /approved .*google_calendar_create_event.* has no recorded outcome/s,
    );
    expect(text).toContain("do not retry a rejected action");
    // Connector-supplied text stays fenced as data.
    expect(text).toContain('<untrusted-content nonce="nonce1234">');
  });
});
