import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Response } from "express";

const authState = vi.hoisted(() => ({ allowed: true, mfa: true }));

// The connector OAuth start routes sit behind main's error posture: SDK errors
// embed entire upstream response bodies, so the browser normally gets a fixed
// sanitized string and the operator reads the real message in the log. These
// tests pin the ONE deliberate exception — ConnectorSetupError, repo-authored
// setup text — and prove that everything else stays sanitized.

const startUserMcpConnectorOAuth = vi.fn();
const refreshUserMcpConnectorTools = vi.fn();
const createUserMcpConnector = vi.fn();
const deleteUserMcpConnector = vi.fn();
const mcpConnectorSetupInstructions = vi.fn();
const startGoogleDriveOAuth = vi.fn();
const getGoogleDriveStatus = vi.fn();
const completeGoogleDriveOAuth = vi.fn();
const disconnectGoogleDrive = vi.fn();
const cancelGoogleDriveOAuth = vi.fn();

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({})),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: Response,
        next: () => void,
    ) => {
        if (!authState.allowed)
            return void res.status(401).json({ detail: "Unauthorized" });
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, res: Response, next: () => void) => {
        if (!authState.mfa)
            return void res
                .status(403)
                .json({ code: "mfa_verification_required" });
        next();
    },
}));

vi.mock("../../lib/mcpConnectors", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../lib/mcpConnectors")>();
    return {
        ...actual,
        startUserMcpConnectorOAuth: (...args: unknown[]) =>
            startUserMcpConnectorOAuth(...args),
        refreshUserMcpConnectorTools: (...args: unknown[]) =>
            refreshUserMcpConnectorTools(...args),
        createUserMcpConnector: (...args: unknown[]) =>
            createUserMcpConnector(...args),
        deleteUserMcpConnector: (...args: unknown[]) =>
            deleteUserMcpConnector(...args),
        mcpConnectorSetupInstructions: (...args: unknown[]) =>
            mcpConnectorSetupInstructions(...args),
    };
});

vi.mock("../../lib/integrations/googleDrive", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("../../lib/integrations/googleDrive")
        >();
    return {
        ...actual,
        completeGoogleDriveOAuth: (...args: unknown[]) =>
            completeGoogleDriveOAuth(...args),
        disconnectGoogleDrive: (...args: unknown[]) =>
            disconnectGoogleDrive(...args),
        cancelGoogleDriveOAuth: (...args: unknown[]) =>
            cancelGoogleDriveOAuth(...args),
        startGoogleDriveOAuth: (...args: unknown[]) =>
            startGoogleDriveOAuth(...args),
        getGoogleDriveStatus: (...args: unknown[]) =>
            getGoogleDriveStatus(...args),
    };
});

import { app } from "../../app";
import { ConnectorSetupError } from "../../lib/mcp/errors";
import { McpOAuthRequiredError } from "../../lib/mcp/oauth";

const ORIGINAL_API_PUBLIC_URL = process.env.API_PUBLIC_URL;

beforeEach(() => {
    vi.clearAllMocks();
    authState.allowed = true;
    authState.mfa = true;
    mcpConnectorSetupInstructions.mockReturnValue(null);
    process.env.API_PUBLIC_URL = "http://localhost:3000/api";
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_API_PUBLIC_URL === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = ORIGINAL_API_PUBLIC_URL;
});

describe("POST /user/mcp-connectors", () => {
    const connector = {
        id: "c1",
        name: "Private server",
        serverUrl: "https://mcp.example.test/mcp",
    };

    it("returns provider setup guidance before inserting a Slack connector", async () => {
        mcpConnectorSetupInstructions.mockReturnValue(
            "Slack MCP requires administrator setup.",
        );
        const res = await request(app).post("/user/mcp-connectors").send({
            name: "Slack",
            serverUrl: "https://mcp.slack.com/mcp",
        });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("connector_setup_required");
        expect(res.body.detail).toContain("administrator setup");
        expect(res.body.detail).not.toContain("localhost");
        expect(createUserMcpConnector).not.toHaveBeenCalled();
    });

    it("deletes the new connector when initial credential validation fails", async () => {
        createUserMcpConnector.mockResolvedValue(connector);
        refreshUserMcpConnectorTools.mockRejectedValue(
            new Error("Bearer token is required"),
        );
        deleteUserMcpConnector.mockResolvedValue(undefined);

        const res = await request(app).post("/user/mcp-connectors").send({
            name: connector.name,
            serverUrl: connector.serverUrl,
        });

        expect(res.status).toBe(400);
        expect(deleteUserMcpConnector).toHaveBeenCalledWith("u1", "c1", {});
    });

    it("exposes the retained connector when failed validation cannot be cleaned up", async () => {
        createUserMcpConnector.mockResolvedValue(connector);
        refreshUserMcpConnectorTools.mockRejectedValue(
            new Error("Bearer token is required"),
        );
        deleteUserMcpConnector.mockRejectedValue(new Error("delete failed"));

        const res = await request(app).post("/user/mcp-connectors").send({
            name: connector.name,
            serverUrl: connector.serverUrl,
        });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            code: "connector_cleanup_failed",
            connectorId: "c1",
            detail: expect.stringContaining("Remove it from Installed"),
        });
        expect(deleteUserMcpConnector).toHaveBeenCalledWith("u1", "c1", {});
    });

    it("keeps the new connector when OAuth authorization is required", async () => {
        createUserMcpConnector.mockResolvedValue(connector);
        refreshUserMcpConnectorTools.mockRejectedValue(
            new McpOAuthRequiredError(),
        );

        const res = await request(app).post("/user/mcp-connectors").send({
            name: connector.name,
            serverUrl: connector.serverUrl,
        });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            connector,
            oauthRequired: true,
        });
        expect(deleteUserMcpConnector).not.toHaveBeenCalled();
    });

    it("returns the refreshed connector when initial validation succeeds", async () => {
        const refreshedConnector = { ...connector, tools: [{ id: "search" }] };
        createUserMcpConnector.mockResolvedValue(connector);
        refreshUserMcpConnectorTools.mockResolvedValue(refreshedConnector);

        const res = await request(app).post("/user/mcp-connectors").send({
            name: connector.name,
            serverUrl: connector.serverUrl,
        });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            connector: refreshedConnector,
            oauthRequired: false,
        });
        expect(refreshUserMcpConnectorTools).toHaveBeenCalledTimes(1);
        expect(deleteUserMcpConnector).not.toHaveBeenCalled();
    });
});

describe("POST /user/mcp-connectors/:id/oauth/start", () => {
    it("returns concise setup guidance without a deployment-specific redirect URI", async () => {
        startUserMcpConnectorOAuth.mockImplementation(
            async () => {
                throw new ConnectorSetupError(
                    "Slack MCP requires administrator setup.",
                );
            },
        );

        const res = await request(app).post("/user/mcp-connectors/c1/oauth/start");

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("connector_setup_required");
        expect(res.body.detail).toContain("administrator setup");
        expect(res.body.detail).not.toContain("localhost");
    });

    it("keeps every other failure sanitized", async () => {
        startUserMcpConnectorOAuth.mockRejectedValue(
            new Error(
                "HTTP 400 <html><body>Error 400 (Bad Request)!!1</body></html>",
            ),
        );

        const res = await request(app).post("/user/mcp-connectors/c1/oauth/start");

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            detail: "Connector authorization could not be started.",
        });
    });
});

describe("POST /user/mcp-connectors/:id/refresh-tools", () => {
    it("signals 'authorize this connector' without a 401, so the browser keeps its session", async () => {
        // Regression: this answered 401 { code: "oauth_required" }. Since
        // authentication moved to HttpOnly cookies, the frontend's
        // authenticatedFetch treats ANY 401 from the API as an expired Mike
        // session and logs the user out — so every OAuth connector's first
        // refresh (the step that opens the consent popup) bounced the user
        // to the login page instead. The client keys on `code`, not status.
        refreshUserMcpConnectorTools.mockRejectedValue(
            new McpOAuthRequiredError(),
        );

        const res = await request(app).post(
            "/user/mcp-connectors/c1/refresh-tools",
        );

        expect(res.status).not.toBe(401);
        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            code: "oauth_required",
            detail: "This connector needs to be authorized again.",
        });
    });
});

describe("POST /user/integrations/google-drive/oauth/start", () => {
    it("returns the Drive setup instructions verbatim", async () => {
        startGoogleDriveOAuth.mockImplementation(
            async (_userId: string, redirectUri: string) => {
                throw new ConnectorSetupError(
                    `Google Drive needs an OAuth client with authorized redirect URI ${redirectUri}; set GOOGLE_DRIVE_OAUTH_CLIENT_ID.`,
                );
            },
        );

        const res = await request(app).post(
            "/user/integrations/google-drive/oauth/start",
        );

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("connector_setup_required");
        expect(res.body.detail).toContain(
            "http://localhost:3000/api/user/integrations/google-drive/oauth/callback",
        );
    });

    it("does not echo arbitrary error messages to the client", async () => {
        startGoogleDriveOAuth.mockRejectedValue(
            new Error(
                'insert into "google_drive_oauth_states" failed: relation does not exist',
            ),
        );

        const res = await request(app).post(
            "/user/integrations/google-drive/oauth/start",
        );

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            detail: "Google Drive authorization could not be started.",
        });
    });
});

describe("GET /user/integrations/google-drive", () => {
    it("adds the redirect URI the operator must register to the status", async () => {
        getGoogleDriveStatus.mockResolvedValue({
            connected: false,
            scope: null,
            configured: false,
            schemaReady: true,
        });

        const res = await request(app).get("/user/integrations/google-drive");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            connected: false,
            scope: null,
            configured: false,
            schemaReady: true,
            redirectUri:
                "http://localhost:3000/api/user/integrations/google-drive/oauth/callback",
        });
    });
});

describe("Google Drive callback and disconnect", () => {
    it("completes only for the authenticated Mike user", async () => {
        completeGoogleDriveOAuth.mockResolvedValue({ userId: "u1" });
        const res = await request(app).get(
            "/user/integrations/google-drive/oauth/finish?state=s&code=c",
        );
        expect(res.status).toBe(200);
        expect(res.text).toContain("Authorization complete");
        expect(res.headers["content-security-policy"]).toContain(
            "script-src 'nonce-",
        );
        expect(completeGoogleDriveOAuth).toHaveBeenCalledWith(
            "u1",
            "s",
            "c",
            expect.anything(),
        );
    });

    it("never embeds arbitrary provider/database/crypto text in the popup or logs", async () => {
        completeGoogleDriveOAuth.mockRejectedValue(
            new Error("secret-internal-sentinel</script>"),
        );
        const res = await request(app).get(
            "/user/integrations/google-drive/oauth/finish?state=s&code=c",
        );
        expect(res.status).toBe(400);
        expect(res.text).not.toContain("secret-internal-sentinel");
        expect(res.text).toContain(
            "Google Drive authorization could not be completed",
        );
        expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
            "secret-internal-sentinel",
        );
    });

    it("sanitizes denied and missing-parameter callbacks without contacting Google", async () => {
        const res = await request(app).get(
            "/user/integrations/google-drive/oauth/finish?error=secret-sentinel",
        );
        expect(res.status).toBe(400);
        expect(res.text).not.toContain("secret-sentinel");
        expect(completeGoogleDriveOAuth).not.toHaveBeenCalled();
        expect(
            (
                await request(app).get(
                    "/user/integrations/google-drive/oauth/finish",
                )
            ).status,
        ).toBe(400);
    });

    it("disconnects only the authenticated user", async () => {
        disconnectGoogleDrive.mockResolvedValue(undefined);
        const res = await request(app).delete(
            "/user/integrations/google-drive",
        );
        expect(res.status).toBe(204);
        expect(disconnectGoogleDrive).toHaveBeenCalledWith(
            "u1",
            expect.anything(),
        );
    });

    it("sanitizes disconnect and status failures", async () => {
        disconnectGoogleDrive.mockRejectedValue(new Error("secret-sentinel"));
        getGoogleDriveStatus.mockRejectedValue(new Error("secret-sentinel"));
        for (const res of [
            await request(app).delete("/user/integrations/google-drive"),
            await request(app).get("/user/integrations/google-drive"),
        ]) {
            expect(res.status).toBe(500);
            expect(res.text).not.toContain("secret-sentinel");
        }
    });

    it("cancels only the caller's selected pending state", async () => {
        cancelGoogleDriveOAuth.mockResolvedValue(undefined);
        const state = "a".repeat(32);
        const res = await request(app)
            .post("/user/integrations/google-drive/oauth/cancel")
            .send({ state, userId: "attacker-chosen" });
        expect(res.status).toBe(204);
        expect(cancelGoogleDriveOAuth).toHaveBeenCalledWith(
            "u1",
            state,
            expect.anything(),
        );
        expect(
            (
                await request(app)
                    .post("/user/integrations/google-drive/oauth/cancel")
                    .send({ state: "bad" })
            ).status,
        ).toBe(400);
    });
});

it.each([
    "/user/integrations/google-drive/oauth/start",
    "/user/integrations/google-drive/oauth/cancel",
])("requires authentication and MFA on %s", async (path) => {
    authState.allowed = false;
    expect(
        (
            await request(app)
                .post(path)
                .send({ state: "a".repeat(32) })
        ).status,
    ).toBe(401);
    authState.allowed = true;
    authState.mfa = false;
    expect(
        (
            await request(app)
                .post(path)
                .send({ state: "a".repeat(32) })
        ).status,
    ).toBe(403);
    expect(startGoogleDriveOAuth).not.toHaveBeenCalled();
    expect(cancelGoogleDriveOAuth).not.toHaveBeenCalled();
});

it("requires authentication and MFA to disconnect Drive", async () => {
    authState.allowed = false;
    expect(
        (await request(app).delete("/user/integrations/google-drive")).status,
    ).toBe(401);
    authState.allowed = true;
    authState.mfa = false;
    expect(
        (await request(app).delete("/user/integrations/google-drive")).status,
    ).toBe(403);
    expect(disconnectGoogleDrive).not.toHaveBeenCalled();
});
