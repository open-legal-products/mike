import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    DbMcpOAuthProvider,
    McpOAuthRequiredError,
    isGoogleOAuthHost,
    providerAuthorizationParams,
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
        assert.equal(
            isGoogleOAuthHost("https://drivemcp.googleapis.com/mcp/v1"),
            true,
        );
        assert.equal(
            isGoogleOAuthHost("https://gmailmcp.googleapis.com/mcp"),
            true,
        );
        assert.equal(isGoogleOAuthHost("https://googleapis.com/x"), true);
    });

    it("rejects non-Google and look-alike hosts", () => {
        assert.equal(isGoogleOAuthHost("https://mcp.example.com/mcp"), false);
        // Suffix-only matches must not pass: this is NOT a google host.
        assert.equal(isGoogleOAuthHost("https://notgoogleapis.com/x"), false);
        // A subdomain of an attacker domain that merely contains the string.
        assert.equal(
            isGoogleOAuthHost("https://googleapis.com.evil.test/mcp"),
            false,
        );
        assert.equal(isGoogleOAuthHost("not a url"), false);
    });
});

describe("providerAuthorizationParams", () => {
    it("requests offline access + consent for Google hosts", () => {
        assert.deepEqual(
            providerAuthorizationParams(
                "https://drivemcp.googleapis.com/mcp/v1",
            ),
            { access_type: "offline", prompt: "consent" },
        );
    });

    it("adds nothing for non-Google hosts", () => {
        assert.deepEqual(
            providerAuthorizationParams("https://mcp.example.com/mcp"),
            {},
        );
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
        assert.ok(url, "expected an authorization URL to be captured");
        // Without these Google never returns a refresh token, so the connector
        // would break as soon as the first access token expires.
        assert.equal(url.searchParams.get("access_type"), "offline");
        assert.equal(url.searchParams.get("prompt"), "consent");
        // The SDK-provided params must be preserved.
        assert.equal(url.searchParams.get("response_type"), "code");
        assert.equal(url.searchParams.get("client_id"), "abc");
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
        assert.ok(url);
        assert.equal(url.searchParams.get("access_type"), null);
        assert.equal(url.searchParams.get("prompt"), null);
    });

    it("refuses to redirect (and captures nothing) in 'use' mode", async () => {
        const provider = new DbMcpOAuthProvider(
            stubDb,
            makeConnector("https://drivemcp.googleapis.com/mcp/v1"),
            "user-1",
            "use",
            "https://app.test/callback",
        );

        await assert.rejects(
            () => provider.redirectToAuthorization(new URL(AUTH_URL)),
            McpOAuthRequiredError,
        );
        assert.equal(provider.lastAuthorizeUrl, null);
    });
});
