// MCP connectors: thin {ok,...}|{ok:false,detail} wrappers over
// lib/mcpConnectors.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. The OAuth callback exchange (completeUserMcpConnectorOAuth) stays
// in the route: it is inseparable from the popup-HTML/CSP response it renders.

import {
    ConnectorSetupError,
    createUserMcpConnector,
    deleteUserMcpConnector,
    getUserMcpConnector,
    listUserMcpConnectors,
    McpOAuthRequiredError,
    mcpConnectorSetupInstructions,
    refreshUserMcpConnectorTools,
    setUserMcpToolEnabled,
    startUserMcpConnectorOAuth,
    updateUserMcpConnector,
} from "../../lib/mcpConnectors";
import type { ConnectorOwner } from "../../lib/connectorOwner";
import { withKind, type ErrorKind } from "../../lib/appError";
import { reportError } from "../../lib/observability/sentry";
import { type Db } from "./user.shared";

/**
 * The failure as Sentry should see it: `mcp.setup_failed` for managing a
 * connector's row (create, update, delete, list, OAuth start, tool toggle),
 * `mcp.call_failed` for talking to its server (tool refresh). The thrown
 * value stays the cause so an SDK error's status or a PostgREST code still
 * extracts; its message (which may embed a whole upstream response body)
 * never leaves the process.
 */
function mcpFailure(kind: ErrorKind, message: string, cause: unknown): Error {
    return withKind(cause, kind, message);
}

/**
 * For a failure the route answers with 4xx and fixed text: reported here, as
 * a warning (the user may well be able to fix it), then logged once — the
 * console bridge knows the object is already reported, so this is one event.
 * Failures the route answers with sendInternalError are not reported here;
 * that call reports and logs them with the request id.
 */
function reportMcpFailure(
    label: string,
    failure: Error,
    context: Record<string, unknown>,
): Error {
    // The ids and the upstream error are for the operator's log line only;
    // the report carries the kind and the cause's code, nothing else.
    reportError(failure, { level: "warning" });
    console.error(label, { ...context, error: failure });
    return failure;
}

export async function listMcpConnectors(
    db: Db,
    owner: ConnectorOwner,
): Promise<{ ok: true; connectors: unknown } | { ok: false; error: unknown }> {
    try {
        const connectors = await listUserMcpConnectors(owner, db, {
            includeTools: false,
        });
        return { ok: true, connectors };
    } catch (err) {
        return {
            ok: false,
            error: mcpFailure("mcp.setup_failed", "connector list failed", err),
        };
    }
}

export async function getMcpConnector(
    db: Db,
    userId: string,
    connectorId: string,
): Promise<{ ok: true; connector: unknown } | { ok: false; error: unknown }> {
    try {
        const connector = await getUserMcpConnector(userId, connectorId, db);
        return { ok: true, connector };
    } catch (err) {
        // The route answers 404: an unknown or foreign id is the common case
        // here, not a fault, so this is a log line and not an event.
        console.warn("[user/mcp-connectors] get failed", {
            userId,
            connectorId,
            error: err,
        });
        return { ok: false, error: err };
    }
}

export async function createMcpConnector(
    db: Db,
    owner: ConnectorOwner,
    params: {
        name: string;
        serverUrl: string;
        bearerToken: string | null;
        headers: Record<string, unknown> | undefined;
    },
): Promise<
    | { ok: true; connector: unknown; oauthRequired: boolean }
    | { ok: false; kind: "setup"; code: string; detail: string }
    | {
          ok: false;
          kind: "cleanup";
          connectorId: string;
          error: unknown;
      }
    | { ok: false; kind: "failed"; error: unknown }
> {
    const { userId } = owner;
    let createdConnectorId: string | null = null;
    try {
        if (!params.bearerToken?.trim()) {
            const setupInstructions = mcpConnectorSetupInstructions(
                params.serverUrl,
            );
            if (setupInstructions) {
                throw new ConnectorSetupError(setupInstructions);
            }
        }
        const connector = await createUserMcpConnector(owner, params, db);
        createdConnectorId = connector.id;
        try {
            return {
                ok: true,
                connector: await refreshUserMcpConnectorTools(
                    userId,
                    connector.id,
                    db,
                ),
                oauthRequired: false,
            };
        } catch (err) {
            // OAuth-backed servers cannot list tools until the browser consent
            // flow completes. That is an expected intermediate state, so keep
            // the row for /oauth/start. Every other initial connection error
            // means registration failed and must not leave an installed row.
            if (err instanceof McpOAuthRequiredError) {
                return { ok: true, connector, oauthRequired: true };
            }
            try {
                await deleteUserMcpConnector(userId, connector.id, db);
            } catch (cleanupError) {
                // A half-installed row the user has to remove by hand: the
                // cleanup failure is the one to see, the registration error
                // rides along as context.
                const failure = reportMcpFailure(
                    "[user/mcp-connectors] cleanup failed",
                    mcpFailure("mcp.setup_failed", "connector cleanup after failed validation", cleanupError),
                    { userId, connectorId: connector.id, registrationError: err },
                );
                return {
                    ok: false,
                    kind: "cleanup",
                    connectorId: connector.id,
                    error: failure,
                };
            }
            createdConnectorId = null;
            throw err;
        }
    } catch (err) {
        // Setup instructions are the answer the user needs, not a failure.
        if (err instanceof ConnectorSetupError) {
            return {
                ok: false,
                kind: "setup",
                code: err.code,
                detail: err.message,
            };
        }
        const failure = reportMcpFailure(
            "[user/mcp-connectors] create failed",
            mcpFailure("mcp.setup_failed", "connector creation failed", err),
            { userId, createdConnectorId },
        );
        return { ok: false, kind: "failed", error: failure };
    }
}

export async function updateMcpConnector(
    db: Db,
    userId: string,
    connectorId: string,
    updates: Parameters<typeof updateUserMcpConnector>[2],
): Promise<{ ok: true; connector: unknown } | { ok: false; error: unknown }> {
    try {
        const connector = await updateUserMcpConnector(
            userId,
            connectorId,
            updates,
            db,
        );
        return { ok: true, connector };
    } catch (err) {
        const failure = reportMcpFailure(
            "[user/mcp-connectors] update failed",
            mcpFailure("mcp.setup_failed", "connector update failed", err),
            { userId, connectorId },
        );
        return { ok: false, error: failure };
    }
}

export async function deleteMcpConnector(
    db: Db,
    userId: string,
    connectorId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserMcpConnector(userId, connectorId, db);
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: mcpFailure("mcp.setup_failed", "connector deletion failed", err),
        };
    }
}

export async function startMcpConnectorOAuth(
    db: Db,
    userId: string,
    connectorId: string,
    redirectUri: string,
): Promise<
    | {
          ok: true;
          result: Awaited<ReturnType<typeof startUserMcpConnectorOAuth>>;
      }
    // The setup error is static text this repo authors, so it is safe to hand
    // to the browser — and it is the one failure here the user can fix.
    // Everything else may carry
    // SDK-embedded upstream bodies and stays opaque; the operator reads the
    // real message in the log.
    | { ok: false; kind: "setup"; code: string; detail: string }
    | { ok: false; kind: "failed"; error: unknown }
> {
    try {
        const result = await startUserMcpConnectorOAuth(
            userId,
            connectorId,
            redirectUri,
            db,
        );
        return { ok: true, result };
    } catch (err) {
        if (err instanceof ConnectorSetupError) {
            return { ok: false, kind: "setup", code: err.code, detail: err.message };
        }
        const failure = reportMcpFailure(
            "[user/mcp-connectors] oauth start failed",
            mcpFailure("mcp.setup_failed", "connector OAuth start failed", err),
            { userId, connectorId },
        );
        return { ok: false, kind: "failed", error: failure };
    }
}

export type RefreshMcpToolsResult =
    | { ok: true; connector: unknown }
    | { ok: false; kind: "oauth_required"; code: string }
    | { ok: false; kind: "refresh_failed"; error: unknown };

export async function refreshMcpConnectorTools(
    db: Db,
    userId: string,
    connectorId: string,
): Promise<RefreshMcpToolsResult> {
    try {
        const connector = await refreshUserMcpConnectorTools(
            userId,
            connectorId,
            db,
        );
        return { ok: true, connector };
    } catch (err) {
        // Needing authorization is an expected intermediate state, not a
        // failure. Everything else: the full error (with any embedded
        // response body) goes to the log as the cause; the user gets fixed
        // text from the route.
        if (err instanceof McpOAuthRequiredError) {
            return { ok: false, kind: "oauth_required", code: err.code };
        }
        const failure = reportMcpFailure(
            "[user/mcp-connectors] refresh failed",
            mcpFailure("mcp.call_failed", "connector tool refresh failed", err),
            { userId, connectorId },
        );
        return { ok: false, kind: "refresh_failed", error: failure };
    }
}

export async function setMcpToolEnabled(
    db: Db,
    userId: string,
    connectorId: string,
    toolId: string,
    enabled: boolean,
): Promise<{ ok: true; connector: unknown } | { ok: false; error: unknown }> {
    try {
        const connector = await setUserMcpToolEnabled(
            userId,
            connectorId,
            toolId,
            enabled,
            db,
        );
        return { ok: true, connector };
    } catch (err) {
        const failure = reportMcpFailure(
            "[user/mcp-connectors] tool toggle failed",
            mcpFailure("mcp.setup_failed", "connector tool toggle failed", err),
            { userId, connectorId, toolId },
        );
        return { ok: false, error: failure };
    }
}
