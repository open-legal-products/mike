import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  connect: vi.fn(),
  urls: [] as string[],
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mocks.connect;
    callTool = mocks.callTool;
    close = async () => {};
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL) {
      mocks.urls.push(url.href);
    }
  },
}));
vi.mock("./oauth", async (original) => ({
  ...(await original<typeof import("./oauth")>()),
  discoverOAuthMetadata: async () => {
    throw new Error("not OAuth");
  },
}));
vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  validateRemoteMcpUrl: async (url: string) => url,
}));
import { authConfigPatch, isMcpWriteTool } from "./client";
import {
  executeMcpToolCall,
  executeApprovedMcpToolCall,
  planMcpToolCall,
} from "./servers";
import type { Db } from "./types";
function fixture(
  annotations: Record<string, unknown> | undefined = { readOnlyHint: false },
) {
  const connector = {
    id: "c1",
    user_id: "u1",
    name: "Original account",
    server_url: "https://original.example.com/mcp",
    auth_type: "none",
    enabled: true,
    read_only: false,
    require_write_approval: false,
    encrypted_auth_config: null as string | null,
    auth_config_iv: null as string | null,
    auth_config_tag: null as string | null,
  };
  const tool = {
    id: "t1",
    connector_id: "c1",
    tool_name: "send_message",
    openai_tool_name: "mcp_c1_send_message",
    enabled: true,
    annotations,
    requires_confirmation: isMcpWriteTool(annotations),
  };
  const token = {
    grant_id: "grant-1",
    encrypted_access_token: "original-token",
  };
  let table = "";
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({
      data: table === "user_mcp_oauth_tokens" ? { ...token } : null,
      error: null,
    }),
    single: async () => ({
      data: { ...tool, user_mcp_connectors: { ...connector } },
      error: null,
    }),
    insert: async () => ({ error: null }),
  };
  const db = {
    from: (name: string) => {
      table = name;
      return chain;
    },
  } as unknown as Db;
  return { connector, tool, db, token };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.urls.length = 0;
  vi.stubEnv(
    "MCP_CONNECTORS_ENCRYPTION_SECRET",
    "test-only-connector-approval-secret",
  );
  mocks.connect.mockResolvedValue(undefined);
  mocks.callTool.mockResolvedValue({
    content: [{ type: "text", text: "sent" }],
  });
});
afterEach(() => vi.unstubAllEnvs());
it("read-only mode must block a write tool whose server omitted annotations", async () => {
  const { connector, tool, db } = fixture({});
  connector.read_only = true;
  connector.require_write_approval = true;
  const plan = await planMcpToolCall(
    "u1",
    tool.openai_tool_name,
    { text: "hello" },
    db,
  );
  expect(plan.type).toBe("result");
});
it("enabling approval while an MCP connection is opening must prevent an unapproved write", async () => {
  const { connector, tool, db } = fixture();
  expect(
    (await planMcpToolCall("u1", tool.openai_tool_name, {}, db)).type,
  ).toBe("run");
  mocks.connect.mockImplementation(async () => {
    connector.require_write_approval = true;
  });
  await executeMcpToolCall("u1", tool.openai_tool_name, { text: "hello" }, db);
  expect(mocks.callTool).not.toHaveBeenCalled();
});
it("an approval reviewed for one server must not execute against a replaced server", async () => {
  const { connector, tool, db } = fixture();
  connector.require_write_approval = true;
  const plan = await planMcpToolCall(
    "u1",
    tool.openai_tool_name,
    { text: "hello" },
    db,
  );
  if (plan.type !== "approval") throw new Error("expected approval");
  connector.server_url = "https://replacement.example.com/mcp";
  await executeApprovedMcpToolCall("u1", { ...plan.item, id: "approval1" }, db);
  expect(mocks.callTool).not.toHaveBeenCalled();
});

it.each([
  undefined,
  null,
  {},
  { destructiveHint: false },
  { readOnlyHint: false },
  { readOnlyHint: true, destructiveHint: true },
])("treats ambiguous annotations as write-capable: %j", (annotations) => {
  expect(isMcpWriteTool(annotations)).toBe(true);
});
it("allows explicitly read-only tools", () => {
  expect(isMcpWriteTool({ readOnlyHint: true })).toBe(false);
});
it("protects cached tools classified before the conservative policy", async () => {
  const { connector, tool, db } = fixture({});
  tool.requires_confirmation = false;
  connector.read_only = true;
  expect(
    (await planMcpToolCall("u1", tool.openai_tool_name, {}, db)).type,
  ).toBe("result");
});
it("runs a valid approved call while retaining the approval requirement", async () => {
  const { connector, tool, db } = fixture();
  connector.require_write_approval = true;
  const plan = await planMcpToolCall(
    "u1",
    tool.openai_tool_name,
    { text: "reviewed" },
    db,
  );
  if (plan.type !== "approval") throw new Error("expected approval");
  const result = await executeApprovedMcpToolCall(
    "u1",
    { ...plan.item, id: "a1" },
    db,
  );
  expect(result.event.status).toBe("ok");
  expect(mocks.callTool).toHaveBeenCalledExactlyOnceWith(
    { name: "send_message", arguments: { text: "reviewed" } },
    undefined,
    expect.any(Object),
  );
});
it.each([
  "credentials",
  "oauth-account",
  "in-flight-server",
  "read-only",
  "legacy",
])("invalidates approvals after %s changes", async (change) => {
  const { connector, tool, db, token } = fixture();
  if (change === "oauth-account") connector.auth_type = "oauth";
  connector.require_write_approval = true;
  const plan = await planMcpToolCall("u1", tool.openai_tool_name, {}, db);
  if (plan.type !== "approval") throw new Error("expected approval");
  if (change === "credentials")
    Object.assign(connector, authConfigPatch({ bearerToken: "replacement" }));
  if (change === "oauth-account") token.grant_id = "replacement-grant";
  if (change === "in-flight-server")
    mocks.connect.mockImplementation(async () => {
      connector.server_url = "https://replacement.example.com/mcp";
    });
  if (change === "read-only") connector.read_only = true;
  if (change === "legacy" && plan.item.binding.type === "mcp")
    delete plan.item.binding.connection_fingerprint;
  expect(
    (await executeApprovedMcpToolCall("u1", { ...plan.item, id: "a1" }, db))
      .event.status,
  ).toBe("error");
  expect(mocks.callTool).not.toHaveBeenCalled();
});
it("retains an approval across routine token refresh", async () => {
  const { connector, tool, db, token } = fixture();
  connector.auth_type = "oauth";
  connector.require_write_approval = true;
  const plan = await planMcpToolCall("u1", tool.openai_tool_name, {}, db);
  if (plan.type !== "approval") throw new Error("expected approval");
  mocks.connect.mockImplementation(async () => {
    token.encrypted_access_token = "refreshed-token";
  });
  expect(
    (await executeApprovedMcpToolCall("u1", { ...plan.item, id: "a1" }, db))
      .event.status,
  ).toBe("ok");
  expect(mocks.callTool).toHaveBeenCalledOnce();
});
