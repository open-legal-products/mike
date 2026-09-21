import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The managed-connector behavior never touches a real process in these
// tests: the transport factory is wrapped in a spy so a denied request can be
// proven to start no child process.
const { createPatentMcpTransportMock, loadConnectorMock } = vi.hoisted(() => ({
    createPatentMcpTransportMock: vi.fn(),
    loadConnectorMock: vi.fn(),
}));

vi.mock("./patentServer", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./patentServer")>();
    return {
        ...actual,
        createPatentMcpTransport: (...args: unknown[]) =>
            createPatentMcpTransportMock(...args),
    };
});

vi.mock("./client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./client")>();
    return {
        ...actual,
        loadConnector: (...args: unknown[]) => loadConnectorMock(...args),
    };
});

import {
    buildUserMcpTools,
    executeMcpToolCall,
    provisionPatentMcpConnector,
    updateUserMcpConnector,
} from "./servers";
import {
    MANAGED_CONNECTOR_SETTINGS_LOCKED,
    MANAGED_CREDENTIALS_ONLY,
    patentManagedToolPolicy,
    PATENT_MCP_SERVER_URI,
} from "./patentServer";
import type { ConnectorRow, Db, ToolCacheRow } from "./types";

function makeManagedConnector(): ConnectorRow {
    return {
        id: "connector-1",
        user_id: "user-1",
        name: "USPTO Patent & Trademark",
        transport: "stdio",
        server_url: PATENT_MCP_SERVER_URI,
        auth_type: "none",
        enabled: true,
        tool_policy: patentManagedToolPolicy(),
        encrypted_auth_config: null,
        auth_config_iv: null,
        auth_config_tag: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };
}

function makeTrademarkTool(): ToolCacheRow {
    return {
        id: "tool-1",
        connector_id: "connector-1",
        tool_name: "tm_search_trademarks",
        openai_tool_name: "mcp_uspto_tm_search_trademarks_abc12345",
        title: "Search trademarks",
        description: "Searches USPTO trademarks.",
        input_schema: { type: "object", properties: {} },
        output_schema: null,
        annotations: null,
        enabled: true,
        requires_confirmation: false,
        last_seen_at: "2026-01-01T00:00:00Z",
    };
}

// Fake db covering the three query shapes used here: the callable-tool join
// (single), the profile feature check (maybeSingle), and audit inserts.
function makeDb(options: {
    toolRow?: Record<string, unknown>;
    profile?: { uspto_connector_enabled?: boolean | null } | null;
    auditRows?: Record<string, unknown>[];
    toolsListRows?: Record<string, unknown>[];
    connectorRow?: ConnectorRow | null;
    insertResult?:
        | { data: Record<string, unknown>; error: null }
        | { data: null; error: { code: string; message: string } };
    updates?: Record<string, unknown>[];
}): Db {
    const singleChain: Record<string, unknown> = {};
    Object.assign(singleChain, {
        select: () => singleChain,
        eq: () => singleChain,
        order: () => singleChain,
        // listUserMcpConnectors awaits this chain directly; an empty list makes
        // updateUserMcpConnector fall back to the single-row result.
        then: (resolve: (value: unknown) => unknown) =>
            resolve({ data: [], error: null }),
        maybeSingle: () =>
            Promise.resolve({ data: options.connectorRow ?? null, error: null }),
        single: () =>
            options.insertResult
                ? Promise.resolve(options.insertResult)
                : Promise.resolve({
                      data: options.toolRow ?? null,
                      error: options.toolRow ? null : { code: "PGRST116" },
                  }),
        insert: () => singleChain,
        update: (row: Record<string, unknown>) => {
            options.updates?.push(row);
            return singleChain;
        },
    });
    return {
        from(table: string) {
            if (table === "user_profiles") {
                return {
                    select: () => ({
                        eq: () => ({
                            maybeSingle: () =>
                                Promise.resolve({
                                    data: options.profile ?? null,
                                    error: null,
                                }),
                        }),
                    }),
                };
            }
            if (table === "user_mcp_tool_audit_logs") {
                return {
                    insert: (row: Record<string, unknown>) => {
                        options.auditRows?.push(row);
                        return Promise.resolve({ error: null });
                    },
                };
            }
            if (table === "user_mcp_connector_tools") {
                // One thenable chain serves both call shapes: buildUserMcpTools
                // awaits the eq-chain directly, resolveCallableTool ends in
                // .single().
                const query: Record<string, unknown> = {};
                Object.assign(query, {
                    eq: () => query,
                    single: () =>
                        Promise.resolve({
                            data: options.toolRow ?? null,
                            error: options.toolRow
                                ? null
                                : { code: "PGRST116" },
                        }),
                    then: (resolve: (v: unknown) => unknown) =>
                        resolve({
                            data: options.toolsListRows ?? [],
                            error: null,
                        }),
                });
                return { select: () => query };
            }
            return singleChain;
        },
    } as unknown as Db;
}

beforeAll(() => {
    // authConfigPatch needs a secret to encrypt with.
    process.env.USER_API_KEYS_ENCRYPTION_SECRET ||= "test-encryption-secret";
});

beforeEach(() => {
    vi.clearAllMocks();
});

describe("executeMcpToolCall feature gate", () => {
    it("rejects a disabled feature before any child process starts", async () => {
        const auditRows: Record<string, unknown>[] = [];
        const db = makeDb({
            toolRow: {
                ...makeTrademarkTool(),
                user_mcp_connectors: makeManagedConnector(),
            },
            profile: { uspto_connector_enabled: false },
            auditRows,
        });

        const { content, event } = await executeMcpToolCall(
            "user-1",
            "mcp_uspto_tm_search_trademarks_abc12345",
            { owner_name: "ACME CORP" },
            db,
        );

        expect(createPatentMcpTransportMock).not.toHaveBeenCalled();
        expect(event.status).toBe("error");
        expect(event.error).toContain("Settings > Features");
        const parsed = JSON.parse(content) as { ok: boolean; error: string };
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toContain("USPTO Patent & Trademark");
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0].status).toBe("error");
    });
});

describe("buildUserMcpTools feature gate", () => {
    const managedToolRow = {
        openai_tool_name: "mcp_uspto_tm_search_trademarks_abc12345",
        tool_name: "tm_search_trademarks",
        title: "Search trademarks",
        description: "Searches USPTO trademarks.",
        input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
        },
        user_mcp_connectors: {
            name: "USPTO Patent & Trademark",
            tool_policy: patentManagedToolPolicy(),
        },
    };
    const remoteToolRow = {
        openai_tool_name: "mcp_remote_lookup_abc12345",
        tool_name: "lookup",
        title: null,
        description: "Looks up things.",
        input_schema: { type: "object", properties: {} },
        user_mcp_connectors: { name: "Remote", tool_policy: {} },
    };

    it("hides managed tools when the feature is off and keeps remote tools", async () => {
        const db = makeDb({
            profile: { uspto_connector_enabled: false },
            toolsListRows: [managedToolRow, remoteToolRow],
        });

        const tools = await buildUserMcpTools("user-1", db);

        expect(tools.map((tool) => tool.function.name)).toEqual([
            "mcp_remote_lookup_abc12345",
        ]);
    });

    it("exposes managed tools with the owner_names schema when the feature is on", async () => {
        const db = makeDb({
            profile: { uspto_connector_enabled: true },
            toolsListRows: [managedToolRow],
        });

        const tools = await buildUserMcpTools("user-1", db);

        expect(tools).toHaveLength(1);
        const parameters = tools[0].function.parameters as {
            properties: Record<string, { type?: unknown; maxItems?: number }>;
        };
        expect(parameters.properties.owner_names).toBeDefined();
        expect(parameters.properties.owner_names.maxItems).toBe(10);
    });
});

describe("provisionPatentMcpConnector", () => {
    it("rejects provisioning while the feature is off", async () => {
        const db = makeDb({ profile: { uspto_connector_enabled: false } });
        await expect(provisionPatentMcpConnector("user-1", db)).rejects.toThrow(
            /Settings > Features/,
        );
    });

    it("inserts one managed stdio connector for a new user", async () => {
        const inserted = makeManagedConnector();
        const db = makeDb({
            profile: { uspto_connector_enabled: true },
            connectorRow: null,
            insertResult: { data: inserted, error: null },
        });

        const summary = await provisionPatentMcpConnector("user-1", db);

        expect(summary.transport).toBe("stdio");
        expect(summary.managed).toBe(true);
        expect(summary.authType).toBe("none");
        expect(summary.serverUrl).toBe(PATENT_MCP_SERVER_URI);
        expect(summary.toolPolicy).toMatchObject({
            managed: "patent_mcp_server",
            package: "patent-mcp-server==1.0.0",
        });
    });

    it("reuses the saved connector on repeat setup and preserves identity", async () => {
        const existing = makeManagedConnector();
        const updates: Record<string, unknown>[] = [];
        const db = makeDb({
            profile: { uspto_connector_enabled: true },
            connectorRow: existing,
            updates,
            insertResult: { data: existing, error: null },
        });

        const summary = await provisionPatentMcpConnector("user-1", db);

        expect(summary.id).toBe(existing.id);
        // The update path refreshes only managed fields; name and enabled
        // are untouched, so user customizations survive repeat setup.
        expect(updates).toHaveLength(1);
        expect(updates[0]).not.toHaveProperty("name");
        expect(updates[0]).not.toHaveProperty("enabled");
    });

    it("stores managed credentials encrypted and never in the clear", async () => {
        loadConnectorMock.mockResolvedValue(makeManagedConnector());
        const updates: Record<string, unknown>[] = [];
        const db = makeDb({
            updates,
            insertResult: { data: makeManagedConnector(), error: null },
        });

        await updateUserMcpConnector(
            "user-1",
            "connector-1",
            { usptoCredentials: { usptoApiKey: "secret-key" } },
            db,
        );

        expect(updates).toHaveLength(1);
        expect(typeof updates[0].encrypted_auth_config).toBe("string");
        expect(updates[0].encrypted_auth_config).toBeTruthy();
        expect(JSON.stringify(updates[0])).not.toContain("secret-key");
    });

    it("rejects managed credentials on a non-managed connector", async () => {
        loadConnectorMock.mockResolvedValue({
            ...makeManagedConnector(),
            transport: "streamable_http",
            server_url: "https://mcp.example.com/mcp",
            tool_policy: {},
        });
        const db = makeDb({});

        await expect(
            updateUserMcpConnector(
                "user-1",
                "connector-1",
                { usptoCredentials: { usptoApiKey: "k" } },
                db,
            ),
        ).rejects.toThrow(MANAGED_CREDENTIALS_ONLY);
    });

    it("still blocks endpoint edits on the managed connector", async () => {
        loadConnectorMock.mockResolvedValue(makeManagedConnector());
        const db = makeDb({});

        await expect(
            updateUserMcpConnector(
                "user-1",
                "connector-1",
                { serverUrl: "https://evil.example.com/mcp" },
                db,
            ),
        ).rejects.toThrow(MANAGED_CONNECTOR_SETTINGS_LOCKED);
    });

    it("collapses a concurrent-insert conflict onto the existing row", async () => {
        const existing = makeManagedConnector();
        const db = makeDb({
            profile: { uspto_connector_enabled: true },
            connectorRow: null,
            insertResult: {
                data: null,
                error: { code: "23505", message: "duplicate key" },
            },
        });
        // The conflict retry path re-reads with single(); the fake serves the
        // winning row there.
        (db as { from: (t: string) => unknown }).from = ((original) =>
            (table: string) => {
                if (table === "user_profiles") return original(table);
                const chain: Record<string, unknown> = {};
                Object.assign(chain, {
                    select: () => chain,
                    eq: () => chain,
                    maybeSingle: () =>
                        Promise.resolve({ data: null, error: null }),
                    single: () =>
                        Promise.resolve({ data: existing, error: null }),
                    insert: () => chain,
                    update: () => chain,
                });
                return chain;
            })(db.from.bind(db));

        const summary = await provisionPatentMcpConnector("user-1", db);

        expect(summary.id).toBe(existing.id);
        expect(summary.managed).toBe(true);
    });
});
