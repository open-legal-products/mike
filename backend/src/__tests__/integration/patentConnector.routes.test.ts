import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Route-level tests for the managed USPTO connector: the feature gate,
// managed-edit restrictions, runtime-unavailable reporting, and sanitized
// failures. The lib functions are mocked; the wrapper and route mapping are
// the real code under test.

const provisionPatentMcpConnector = vi.fn();
const refreshUserMcpConnectorTools = vi.fn();
const updateUserMcpConnector = vi.fn();
const deleteUserMcpConnector = vi.fn();

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({})),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/mcpConnectors", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../lib/mcpConnectors")>();
    return {
        ...actual,
        provisionPatentMcpConnector: (...args: unknown[]) =>
            provisionPatentMcpConnector(...args),
        refreshUserMcpConnectorTools: (...args: unknown[]) =>
            refreshUserMcpConnectorTools(...args),
        updateUserMcpConnector: (...args: unknown[]) =>
            updateUserMcpConnector(...args),
        deleteUserMcpConnector: (...args: unknown[]) =>
            deleteUserMcpConnector(...args),
    };
});

import { app } from "../../app";
import {
    MANAGED_CONNECTOR_DELETE_LOCKED,
    MANAGED_CONNECTOR_SETTINGS_LOCKED,
    PatentRuntimeUnavailableError,
    UsptoConnectorDisabledError,
} from "../../lib/mcp/patentServer";

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("POST /user/mcp-connectors/presets/patent", () => {
    it("rejects provisioning with 403 while the feature is off", async () => {
        provisionPatentMcpConnector.mockRejectedValue(
            new UsptoConnectorDisabledError(),
        );

        const res = await request(app).post(
            "/user/mcp-connectors/presets/patent",
        );

        expect(res.status).toBe(403);
        expect(res.body.code).toBe("feature_disabled");
        expect(res.body.detail).toContain("Settings > Features");
        expect(refreshUserMcpConnectorTools).not.toHaveBeenCalled();
    });

    it("reports a missing runtime as 409, distinct from the saved preference", async () => {
        provisionPatentMcpConnector.mockResolvedValue({ id: "c1" });
        refreshUserMcpConnectorTools.mockRejectedValue(
            new PatentRuntimeUnavailableError(
                "The USPTO connector runtime is not available on this server.",
            ),
        );

        const res = await request(app).post(
            "/user/mcp-connectors/presets/patent",
        );

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("runtime_unavailable");
    });

    it("returns 201 with the refreshed connector on success", async () => {
        provisionPatentMcpConnector.mockResolvedValue({ id: "c1" });
        refreshUserMcpConnectorTools.mockResolvedValue({
            id: "c1",
            name: "USPTO Patent & Trademark",
            transport: "stdio",
            managed: true,
        });

        const res = await request(app).post(
            "/user/mcp-connectors/presets/patent",
        );

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ id: "c1", transport: "stdio" });
    });

    it("sanitizes unexpected provisioning failures", async () => {
        provisionPatentMcpConnector.mockRejectedValue(
            new Error("spawn uvx ENOENT with secret stack detail"),
        );

        const res = await request(app).post(
            "/user/mcp-connectors/presets/patent",
        );

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            detail: "The USPTO connector could not be set up.",
        });
    });
});

describe("managed connector edit restrictions", () => {
    it("returns the intentional message when managed settings are patched", async () => {
        updateUserMcpConnector.mockRejectedValue(
            new Error(MANAGED_CONNECTOR_SETTINGS_LOCKED),
        );

        const res = await request(app)
            .patch("/user/mcp-connectors/c1")
            .send({ serverUrl: "https://evil.example.com/mcp" });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(MANAGED_CONNECTOR_SETTINGS_LOCKED);
    });

    it("passes only known managed credential fields to the service", async () => {
        updateUserMcpConnector.mockResolvedValue({ id: "c1" });

        const res = await request(app)
            .patch("/user/mcp-connectors/c1")
            .send({
                usptoCredentials: { usptoApiKey: "k", ignored: "drop-me" },
            });

        expect(res.status).toBe(200);
        expect(updateUserMcpConnector.mock.calls[0][2]).toMatchObject({
            usptoCredentials: { usptoApiKey: "k" },
        });
        expect(
            updateUserMcpConnector.mock.calls[0][2].usptoCredentials,
        ).not.toHaveProperty("ignored");
    });

    it("rejects a non-string credential value without calling the service", async () => {
        const res = await request(app)
            .patch("/user/mcp-connectors/c1")
            .send({ usptoCredentials: { usptoApiKey: 123 } });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "USPTO credential values must be strings.",
        );
        expect(updateUserMcpConnector).not.toHaveBeenCalled();
    });

    it("returns the intentional message when a managed connector is deleted", async () => {
        deleteUserMcpConnector.mockRejectedValue(
            new Error(MANAGED_CONNECTOR_DELETE_LOCKED),
        );

        const res = await request(app).delete("/user/mcp-connectors/c1");

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(MANAGED_CONNECTOR_DELETE_LOCKED);
    });
});

describe("POST /user/mcp-connectors/:id/refresh-tools feature gate", () => {
    it("rejects refreshes with 403 while the feature is off", async () => {
        refreshUserMcpConnectorTools.mockRejectedValue(
            new UsptoConnectorDisabledError(),
        );

        const res = await request(app).post(
            "/user/mcp-connectors/c1/refresh-tools",
        );

        expect(res.status).toBe(403);
        expect(res.body.code).toBe("feature_disabled");
    });

    it("reports a missing runtime as 409", async () => {
        refreshUserMcpConnectorTools.mockRejectedValue(
            new PatentRuntimeUnavailableError("runtime missing"),
        );

        const res = await request(app).post(
            "/user/mcp-connectors/c1/refresh-tools",
        );

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("runtime_unavailable");
    });
});
