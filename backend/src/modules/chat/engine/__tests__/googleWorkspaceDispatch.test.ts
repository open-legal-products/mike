import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runToolCalls } from "../tools/toolDispatcher";
import { workspaceDb } from "../../../../lib/integrations/__tests__/googleWorkspaceDb";
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
it("dispatches a read and a proposal through the real chat tool loop, but never exposes execution to the model", async () => {
  const store = workspaceDb();
  store.tables.user_google_workspace_tokens.push({
    user_id: "u1",
    provider: "gmail",
    grant_id: "g1",
    account_email: "other@example.com",
    write_enabled: true,
    expires_at: "2099-01-01",
    ...encryptFields("access_token", "test-token"),
  });
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: "m1" }] })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const write = vi.fn();
  const result = await runToolCalls(
    [
      {
        id: "read",
        function: {
          name: "gmail_search",
          arguments: JSON.stringify({ query: "fixture" }),
        },
      },
      {
        id: "proposal",
        function: {
          name: "gmail_propose_send",
          arguments: JSON.stringify({
            to: ["test@example.com"],
            subject: "hello",
            body: "fixture",
          }),
        },
      },
      {
        id: "forged-approval",
        function: {
          name: "gmail_approve",
          arguments: JSON.stringify({ approved: true }),
        },
      },
    ],
    new Map(),
    "u1",
    store.db,
    write,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(store.tables.google_workspace_actions).toHaveLength(1);
  expect(store.tables.google_workspace_actions[0].status).toBe("pending");
  expect(result.mcpEvents.map((e) => e.status)).toEqual(["ok", "ok", "error"]);
  expect(result.mcpEvents[1].google_action_id).toBe(
    store.tables.google_workspace_actions[0].id,
  );
  expect(JSON.stringify(result.toolResults)).toContain("awaiting_approval");
  const stream = write.mock.calls.map((c) => c[0]).join("");
  expect(stream).toContain("mcp_tool_result");
  expect(stream).toContain(String(store.tables.google_workspace_actions[0].id));
});
