import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the two module-internal seams that would otherwise require a live
// MCP server and Supabase: the SDK's `auth()` driver and `loadConnector`. Their
// vi.fn()s are created via vi.hoisted so the (hoisted) vi.mock factories below
// can reference them without a temporal-dead-zone error.
const { authMock, loadConnectorMock } = vi.hoisted(() => ({
    authMock: vi.fn(),
    loadConnectorMock: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
    auth: (...args: unknown[]) => authMock(...args),
}));

vi.mock("./client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./client")>();
    return {
        ...actual,
        loadConnector: (...args: unknown[]) => loadConnectorMock(...args),
    };
});

import {
    DbMcpOAuthProvider,
    McpOAuthRequiredError,
    isGoogleOAuthHost,
    providerAuthorizationParams,
    startUserMcpConnectorOAuth,
} from "./oauth";
import type { ConnectorRow, Db } from "./types";

// The provider methods exercised here only read connector.server_url and the
// mode, and never touch the database, so an empty stub satisfies the type.
const stubDb = {} as Db;

function makeConnector(serverUrl: string): ConnectorRow {
    return {
        id: "00000000-0000-0000-0000-000000000000",
        user_id: "user-1",
        name: "Test connector",
        transport: "streamable_http",
        server_url: serverUrl,
        auth_type: "oauth",
        enabled: true,
        tool_policy: {},
        encrypted_auth_config: null,
        auth_config_iv: null,
        auth_config_tag: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };
}

// A representative authorization URL as the MCP SDK would hand it to the
// provider, already carrying the standard OAuth params.
const AUTH_URL =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&code_challenge=xyz";

describe("isGoogleOAuthHost", () => {
    it("matches googleapis.com and its real subdomains", () => {
        expect(
            isGoogleOAuthHost("https://drivemcp.googleapis.com/mcp/v1"),
        ).toBe(true);
        expect(
            isGoogleOAuthHost("https://gmailmcp.googleapis.com/mcp"),
        ).toBe(true);
        expect(isGoogleOAuthHost("https://googleapis.com/x")).toBe(true);
    });

    it("rejects non-Google and look-alike hosts", () => {
        expect(isGoogleOAuthHost("https://mcp.example.com/mcp")).toBe(false);
        // Suffix-only matches must not pass: this is NOT a google host.
        expect(isGoogleOAuthHost("https://notgoogleapis.com/x")).toBe(false);
        // A subdomain of an attacker domain that merely contains the string.
        expect(
            isGoogleOAuthHost("https://googleapis.com.evil.test/mcp"),
        ).toBe(false);
        expect(isGoogleOAuthHost("not a url")).toBe(false);
    });

    it("matches the absolute (trailing-dot) form of a Google host", () => {
        // `https://googleapis.com./x` names the same host as
        // `googleapis.com`; `URL` keeps the trailing dot, so without stripping
        // it the offline-access params would be silently skipped.
        expect(isGoogleOAuthHost("https://googleapis.com./x")).toBe(true);
        expect(
            isGoogleOAuthHost("https://drivemcp.googleapis.com./mcp"),
        ).toBe(true);
    });

    it("still rejects a look-alike host that carries a trailing dot", () => {
        expect(isGoogleOAuthHost("https://notgoogleapis.com./x")).toBe(false);
    });
});

describe("providerAuthorizationParams", () => {
    it("requests offline access + consent for Google hosts", () => {
        expect(
            providerAuthorizationParams(
                "https://drivemcp.googleapis.com/mcp/v1",
            ),
        ).toEqual({ access_type: "offline", prompt: "consent" });
    });

    it("adds nothing for non-Google hosts", () => {
        expect(
            providerAuthorizationParams("https://mcp.example.com/mcp"),
        ).toEqual({});
    });
});

describe("DbMcpOAuthProvider.redirectToAuthorization", () => {
    it("requests offline access + consent for Google hosts when initiating", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://drivemcp.googleapis.com/mcp/v1"),
            "user-1",
            "initiate",
            "https://app.test/callback",
        );

        await provider.redirectToAuthorization(new URL(AUTH_URL));

        const url = provider.lastAuthorizeUrl;
        expect(url).not.toBeNull();
        if (!url) throw new Error("expected an authorization URL");
        // Without these Google never returns a refresh token, so the connector
        // would break as soon as the first access token expires.
        expect(url.searchParams.get("access_type")).toBe("offline");
        expect(url.searchParams.get("prompt")).toBe("consent");
        // The SDK-provided params must be preserved.
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("client_id")).toBe("abc");
    });

    it("leaves non-Google authorization URLs untouched", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://mcp.example.com/mcp"),
            "user-1",
            "initiate",
            "https://app.test/callback",
        );

        await provider.redirectToAuthorization(new URL(AUTH_URL));

        const url = provider.lastAuthorizeUrl;
        expect(url).not.toBeNull();
        if (!url) throw new Error("expected an authorization URL");
        expect(url.searchParams.get("access_type")).toBeNull();
        expect(url.searchParams.get("prompt")).toBeNull();
    });

    it("refuses to redirect (and captures nothing) in 'use' mode", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://drivemcp.googleapis.com/mcp/v1"),
            "user-1",
            "use",
            "https://app.test/callback",
        );

        await expect(
            provider.redirectToAuthorization(new URL(AUTH_URL)),
        ).rejects.toBeInstanceOf(McpOAuthRequiredError);
        expect(provider.lastAuthorizeUrl).toBeNull();
    });
});

// Records every `.from(table).delete().eq(column, value)` chain so a test can
// assert exactly which rows the provider invalidated, without a real database.
type RecordedDelete = { table: string; column: string; value: unknown };

function makeRecordingDb(deletes: RecordedDelete[]): Db {
    return {
        from(table: string) {
            return {
                delete() {
                    return {
                        eq(column: string, value: unknown) {
                            deletes.push({ table, column, value });
                            return Promise.resolve({ error: null });
                        },
                    };
                },
            };
        },
    } as unknown as Db;
}

describe("startUserMcpConnectorOAuth", () => {
    // Any real deployment that reaches these flows has a Google OAuth client
    // configured (Google offers no dynamic registration); mirror that here so
    // the suite exercises the flow rather than the missing-client guard. The
    // guard itself is tested explicitly below.
    const PRIOR_CLIENT_ID = process.env.GOOGLE_MCP_OAUTH_CLIENT_ID;
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GOOGLE_MCP_OAUTH_CLIENT_ID =
            "test-client.apps.googleusercontent.com";
    });
    afterEach(() => {
        if (PRIOR_CLIENT_ID === undefined) {
            delete process.env.GOOGLE_MCP_OAUTH_CLIENT_ID;
        } else {
            process.env.GOOGLE_MCP_OAUTH_CLIENT_ID = PRIOR_CLIENT_ID;
        }
    });

    it("fails fast with setup instructions when no Google OAuth client is configured", async () => {
        delete process.env.GOOGLE_MCP_OAUTH_CLIENT_ID;
        const connector = makeConnector(
            "https://drivemcp.googleapis.com/mcp/v1",
        );
        loadConnectorMock.mockResolvedValue(connector);
        // No stored token row either — the true first-run state.
        const db = {
            from() {
                return {
                    select() {
                        return {
                            eq() {
                                return {
                                    maybeSingle: () =>
                                        Promise.resolve({
                                            data: null,
                                            error: null,
                                        }),
                                };
                            },
                        };
                    },
                };
            },
        } as unknown as Db;

        await expect(
            startUserMcpConnectorOAuth(
                "user-1",
                connector.id,
                "https://app.test/callback",
                db,
            ),
        ).rejects.toThrow(/GOOGLE_MCP_OAUTH_CLIENT_ID/);
        // The message must carry the deployment's actual redirect URI so the
        // operator can paste it straight into the Google Cloud Console form.
        await expect(
            startUserMcpConnectorOAuth(
                "user-1",
                connector.id,
                "https://app.test/callback",
                db,
            ),
        ).rejects.toThrow(/https:\/\/app\.test\/callback/);
        expect(authMock).not.toHaveBeenCalled();
    });

    it("invalidates the stale token row when an interactive redirect is required", async () => {
        // The exact broken-fleet state this PR targets: the SDK cannot complete
        // from stored credentials (expired access token, no usable refresh
        // token), so it reaches the authorization-redirect branch.
        const connector = makeConnector(
            "https://drivemcp.googleapis.com/mcp/v1",
        );
        loadConnectorMock.mockResolvedValue(connector);
        authMock.mockImplementation(async (provider: DbMcpOAuthProvider) => {
            await provider.redirectToAuthorization(new URL(AUTH_URL));
            return "REDIRECT";
        });
        const deletes: RecordedDelete[] = [];
        const db = makeRecordingDb(deletes);

        const result = await startUserMcpConnectorOAuth(
            "user-1",
            connector.id,
            "https://app.test/callback",
            db,
        );

        expect(result.alreadyAuthorized).toBe(false);
        expect(result.authorizationUrl).toContain("access_type=offline");
        // Without this delete `oauthConnected` (!!encrypted_access_token) would
        // stay true on a dead token and the frontend poll would resolve on a
        // phantom success, closing the consent popup mid-flow.
        expect(deletes).toContainEqual({
            table: "user_mcp_oauth_tokens",
            column: "connector_id",
            value: connector.id,
        });
    });

    it("does not touch stored tokens when the connector is already authorized", async () => {
        const connector = makeConnector("https://mcp.example.com/mcp");
        loadConnectorMock.mockResolvedValue(connector);
        authMock.mockResolvedValue("AUTHORIZED");
        const deletes: RecordedDelete[] = [];
        const db = makeRecordingDb(deletes);

        const result = await startUserMcpConnectorOAuth(
            "user-1",
            connector.id,
            "https://app.test/callback",
            db,
        );

        expect(result).toEqual({
            authorizationUrl: null,
            alreadyAuthorized: true,
        });
        expect(deletes).toHaveLength(0);
    });
});
