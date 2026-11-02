import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runToolCalls } from "../tools/toolDispatcher";
import { workspaceDb } from "../../../../lib/integrations/__tests__/googleWorkspaceDb";
import { driveDb } from "../../../../lib/integrations/__tests__/googleDriveDb";
import { encryptFields } from "../../../../lib/integrations/googleWorkspaceAuth";
beforeEach(() => {
  vi.stubEnv("MCP_CONNECTORS_ENCRYPTION_SECRET", "test-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const send = {
  id: "send",
  function: {
    name: "gmail_send",
    arguments: JSON.stringify({
      to: ["test@example.com"],
      subject: "hello",
      body: "fixture",
    }),
  },
};

it.each([false, true])("dispatches Drive writes with approval required: %s", async (requiresApproval) => {
  const store = driveDb({ tokenRow: {
    user_id: "u1", grant_id: "drive-grant", scope: "https://www.googleapis.com/auth/drive",
    require_write_approval: requiresApproval, expires_at: "2099-01-01",
    ...encryptFields("access_token", "test-token"),
  } });
  const fetchMock = vi.fn(async () => Response.json({ id: "folder-created" }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await runToolCalls(
    [{ id: "create-folder", function: { name: "google_drive_create_folder", arguments: JSON.stringify({ name: "Matter" }) } }],
    new Map(), "u1", store.db, vi.fn(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { connectorApprovals: true },
  );
  expect(fetchMock).toHaveBeenCalledTimes(requiresApproval ? 0 : 1);
  if (requiresApproval) {
    expect(result.askInputsEvents[0].items[0]).toMatchObject({ kind: "approval", tool_name: "google_drive_create_folder", binding: { provider: "google-drive", grant_id: "drive-grant" } });
  } else {
    expect(result.mcpEvents[0]).toMatchObject({ status: "ok", connector_name: "Google Drive" });
  }
});

function gmailStore(requireWriteApproval: boolean) {
  const store = workspaceDb();
  store.tables.user_google_workspace_tokens.push({
    user_id: "u1",
    provider: "gmail",
    grant_id: "g1",
    account_email: "other@example.com",
    write_enabled: true,
    require_write_approval: requireWriteApproval,
    expires_at: "2099-01-01",
    ...encryptFields("access_token", "test-token"),
  });
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ id: "m1" })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { store, fetchMock };
}

async function dispatch(
  store: ReturnType<typeof workspaceDb>,
  calls: Parameters<typeof runToolCalls>[0],
  connectorApprovals: boolean,
) {
  const write = vi.fn();
  const result = await runToolCalls(
    calls,
    new Map(),
    "u1",
    store.db,
    write,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { connectorApprovals },
  );
  return { result, stream: write.mock.calls.map((c) => c[0]).join("") };
}

it("runs reads and writes directly when the connection does not ask for permission", async () => {
  const { store, fetchMock } = gmailStore(false);
  const { result, stream } = await dispatch(
    store,
    [
      {
        id: "read",
        function: {
          name: "gmail_search",
          arguments: JSON.stringify({ query: "fixture" }),
        },
      },
      send,
      {
        id: "forged-approval",
        function: {
          name: "gmail_approve",
          arguments: JSON.stringify({ approved: true }),
        },
      },
    ],
    true,
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1][0])).toContain("/messages/send");
  expect(result.mcpEvents.map((e) => e.status)).toEqual(["ok", "ok", "error"]);
  expect(result.askInputsEvents).toEqual([]);
  expect(stream).toContain("mcp_tool_result");
});

it("pauses a write on an approval item when the connection asks for permission", async () => {
  const { store, fetchMock } = gmailStore(true);
  const { result, stream } = await dispatch(
    store,
    [
      {
        id: "read",
        function: {
          name: "gmail_search",
          arguments: JSON.stringify({ query: "fixture" }),
        },
      },
      send,
    ],
    true,
  );
  // The read ran; the send did not.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.mcpEvents).toHaveLength(1);
  expect(result.askInputsEvents).toHaveLength(1);
  const [item] = result.askInputsEvents[0].items;
  expect(item).toMatchObject({
    kind: "approval",
    connector_name: "Gmail",
    tool_name: "gmail_send",
    title: "Send email",
    arguments: { to: ["test@example.com"], subject: "hello", body: "fixture" },
    binding: { type: "google", provider: "gmail", grant_id: "g1" },
  });
  expect(item.id).toEqual(expect.any(String));
  expect(JSON.stringify(result.toolResults)).toContain("awaiting_approval");
  expect(stream).not.toContain("gmail_send");
});

it("refuses a write that needs approval on a surface that cannot pause for it", async () => {
  const { store, fetchMock } = gmailStore(true);
  const { result } = await dispatch(store, [send], false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.askInputsEvents).toEqual([]);
  expect(result.mcpEvents[0]).toMatchObject({ status: "error" });
  expect(result.mcpEvents[0].error).toContain("only available in the Mike assistant");
});
