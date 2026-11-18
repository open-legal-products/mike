import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorRow, Db, ToolCacheRow } from "./types";

// Only the transport is faked: the call runs through callResolvedTool, so
// the serializer, cap, truncation flag and audit row are the real ones.
const mocks = vi.hoisted(() => ({ callTool: vi.fn(), connect: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: class {
        connect = mocks.connect;
        callTool = mocks.callTool;
        close = async () => {};
    },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
    StreamableHTTPClientTransport: class {},
}));
vi.mock("./client", async (original) => ({
    ...(await original<typeof import("./client")>()),
    validateRemoteMcpUrl: async (url: string) => url,
}));

import { executeMcpToolCall } from "./servers";
import { MAX_MCP_RESULT_CHARS } from "./types";
import { personalConnectorOwner } from "../connectorOwner";

const connector = {
    id: "connector-1",
    user_id: "user-1",
    org_id: null,
    name: "Docs",
    transport: "streamable_http",
    server_url: "https://docs.example.com/mcp",
    auth_type: "none",
    enabled: true,
    read_only: true,
    tool_policy: {},
    encrypted_auth_config: null,
    auth_config_iv: null,
    auth_config_tag: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
} as unknown as ConnectorRow;
const tool = {
    id: "tool-1",
    connector_id: "connector-1",
    tool_name: "get_document",
    openai_tool_name: "mcp_connector_1_get_document",
    title: null,
    description: null,
    input_schema: {},
    output_schema: null,
    annotations: { readOnlyHint: true },
    enabled: true,
    requires_confirmation: false,
    last_seen_at: "2026-01-01T00:00:00Z",
} as ToolCacheRow;

function makeDb(auditRows: Record<string, unknown>[]): Db {
    const row = { ...tool, user_mcp_connectors: connector };
    const chain = {
        select: () => chain,
        eq: () => chain,
        filter: () => chain,
        single: async () => ({ data: row, error: null }),
    };
    return {
        from(table: string) {
            if (table === "user_mcp_tool_audit_logs") {
                return {
                    insert: async (value: Record<string, unknown>) => {
                        auditRows.push(value);
                        return { error: null };
                    },
                };
            }
            return chain;
        },
    } as unknown as Db;
}

describe("per-call MCP result cap", () => {
    beforeEach(() => {
        mocks.callTool.mockReset();
        mocks.connect.mockResolvedValue(undefined);
        mocks.callTool.mockResolvedValue({
            structuredContent: { text: "x".repeat(210_000) },
        });
    });

    it("keeps the general cap for every connector by default", async () => {
        const auditRows: Record<string, unknown>[] = [];
        const result = await executeMcpToolCall(
            personalConnectorOwner("user-1"),
            tool.openai_tool_name,
            {},
            makeDb(auditRows),
        );
        expect(result.event.status).toBe("ok");
        expect(result.truncated).toBe(true);
        expect(result.content).toContain(
            `[Truncated MCP result to ${MAX_MCP_RESULT_CHARS} characters]`,
        );
        expect(result.content.length).toBeLessThan(MAX_MCP_RESULT_CHARS + 100);
        expect(auditRows[0]).toMatchObject({ result_size_chars: result.content.length });
        // The provider hook still sees the complete result.
        expect(result.call?.result).toEqual({ structuredContent: { text: "x".repeat(210_000) } });
    });

    it("lets the caller allow a known server more, never less", async () => {
        const allowed = await executeMcpToolCall(
            personalConnectorOwner("user-1"),
            tool.openai_tool_name,
            {},
            makeDb([]),
            {
                maxResultChars: (call) =>
                    call.serverUrl === connector.server_url && call.toolName === "get_document"
                        ? 200_000
                        : undefined,
            },
        );
        expect(allowed.content).toContain("[Truncated MCP result to 200000 characters]");
        expect(allowed.truncated).toBe(true);

        const fits = await executeMcpToolCall(
            personalConnectorOwner("user-1"),
            tool.openai_tool_name,
            {},
            makeDb([]),
            { maxResultChars: () => 300_000 },
        );
        expect(fits.truncated).toBe(false);
        expect(fits.content).not.toContain("[Truncated");

        const lowered = await executeMcpToolCall(
            personalConnectorOwner("user-1"),
            tool.openai_tool_name,
            {},
            makeDb([]),
            { maxResultChars: () => 10 },
        );
        expect(lowered.content).toContain(
            `[Truncated MCP result to ${MAX_MCP_RESULT_CHARS} characters]`,
        );
    });
});
