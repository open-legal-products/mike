// How MCP connector failures reach Sentry: a failure the route answers with
// sendInternalError is handed back as an AppError (reported there, once,
// with the request id); a failure the route answers with 4xx and fixed text
// is reported here, as a warning, before the same object is logged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { AppError } from "../../../lib/appError";
import { personalConnectorOwner } from "../../../lib/connectorOwner";

const mocks = vi.hoisted(() => ({
    reportError: vi.fn((..._args: unknown[]) => "event-1"),
    listUserMcpConnectors: vi.fn(),
    refreshUserMcpConnectorTools: vi.fn(),
    createUserMcpConnector: vi.fn(),
}));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reportError: mocks.reportError,
}));
vi.mock("../../../lib/mcpConnectors", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listUserMcpConnectors: (...args: unknown[]) => mocks.listUserMcpConnectors(...args),
    refreshUserMcpConnectorTools: (...args: unknown[]) =>
        mocks.refreshUserMcpConnectorTools(...args),
    createUserMcpConnector: (...args: unknown[]) => mocks.createUserMcpConnector(...args),
}));
import { ConnectorSetupError } from "../../../lib/mcp/errors";
import { McpOAuthRequiredError } from "../../../lib/mcp/oauth";
import {
    createMcpConnector,
    listMcpConnectors,
    refreshMcpConnectorTools,
} from "../user.mcp";

const db = {} as Db;

describe("MCP connector failure reporting", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });

    it("hands a failed list back as mcp.setup_failed for the route to report, without reporting it here", async () => {
        const cause = { code: "08006", message: "connection lost" };
        mocks.listUserMcpConnectors.mockRejectedValue(cause);

        const result = await listMcpConnectors(db, personalConnectorOwner("u1"));

        expect(result.ok).toBe(false);
        const failure = (result as { error: unknown }).error;
        expect(failure).toBeInstanceOf(AppError);
        expect((failure as AppError).kind).toBe("mcp.setup_failed");
        expect((failure as AppError).cause).toBe(cause);
        expect(mocks.reportError).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it("reports a failed tool refresh as a warning under mcp.call_failed, logging the same object once", async () => {
        const cause = new Error(
            "<html>502 Bad Gateway</html> from https://mcp.example.test/sse",
        );
        mocks.refreshUserMcpConnectorTools.mockRejectedValue(cause);

        const result = await refreshMcpConnectorTools(db, "u1", "connector-1");

        expect(result).toMatchObject({ ok: false, kind: "refresh_failed" });
        const failure = (result as { error: unknown }).error as AppError;
        expect(failure).toBeInstanceOf(AppError);
        expect(failure.kind).toBe("mcp.call_failed");
        expect(failure.cause).toBe(cause);
        expect(mocks.reportError).toHaveBeenCalledOnce();
        expect(mocks.reportError).toHaveBeenCalledWith(failure, {
            level: "warning",
            extra: { userId: "u1", connectorId: "connector-1" },
        });
        expect(console.error).toHaveBeenCalledWith(
            "[user/mcp-connectors] refresh failed",
            expect.objectContaining({ error: failure }),
        );
    });

    it("treats a refresh that needs authorization as a state, not a failure", async () => {
        mocks.refreshUserMcpConnectorTools.mockRejectedValue(
            new McpOAuthRequiredError("authorize first"),
        );

        const result = await refreshMcpConnectorTools(db, "u1", "connector-1");

        expect(result).toMatchObject({ ok: false, kind: "oauth_required", code: "oauth_required" });
        expect(mocks.reportError).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it("answers setup instructions without an event, and reports any other creation failure", async () => {
        mocks.createUserMcpConnector.mockRejectedValueOnce(
            new ConnectorSetupError("Register the redirect URI first."),
        );
        const params = {
            name: "Example",
            serverUrl: "https://mcp.example.test",
            bearerToken: null,
            headers: undefined,
        };

        const setup = await createMcpConnector(db, personalConnectorOwner("u1"), params);
        expect(setup).toMatchObject({
            ok: false,
            kind: "setup",
            code: "connector_setup_required",
            detail: "Register the redirect URI first.",
        });
        expect(mocks.reportError).not.toHaveBeenCalled();

        const cause = new Error("insert failed");
        mocks.createUserMcpConnector.mockRejectedValueOnce(cause);
        const failed = await createMcpConnector(db, personalConnectorOwner("u1"), params);
        expect(failed).toMatchObject({ ok: false, kind: "failed" });
        const failure = (failed as { error: unknown }).error as AppError;
        expect(failure.kind).toBe("mcp.setup_failed");
        expect(failure.cause).toBe(cause);
        expect(mocks.reportError).toHaveBeenCalledOnce();
        expect(mocks.reportError.mock.calls[0]?.[1]).toMatchObject({ level: "warning" });
    });
});
