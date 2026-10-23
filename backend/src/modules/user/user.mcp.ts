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
import { type Db, errorMessage } from "./user.shared";

export async function listMcpConnectors(
    db: Db,
    owner: ConnectorOwner,
): Promise<{ ok: true; connectors: unknown } | { ok: false; error: unknown }> {
    const { userId } = owner;
    try {
        const connectors = await listUserMcpConnectors(owner, db, {
            includeTools: false,
        });
        return { ok: true, connectors };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] list failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
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
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] get failed", {
            userId,
            connectorId,
            error: detail,
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
                console.error("[user/mcp-connectors] cleanup failed", {
                    userId,
                    connectorId: connector.id,
                    registrationError: errorMessage(err),
                    cleanupError: errorMessage(cleanupError),
                });
                return {
                    ok: false,
                    kind: "cleanup",
                    connectorId: connector.id,
                    error: cleanupError,
                };
            }
            createdConnectorId = null;
            throw err;
        }
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] create failed", {
            userId,
            createdConnectorId,
            error: detail,
        });
        if (err instanceof ConnectorSetupError) {
            return {
                ok: false,
                kind: "setup",
                code: err.code,
                detail: err.message,
            };
        }
        return { ok: false, kind: "failed", error: err };
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
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] update failed", {
            userId,
            connectorId,
            error: detail,
        });
        return { ok: false, error: err };
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
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] delete failed", {
            userId,
            connectorId,
            error: detail,
        });
        return { ok: false, error: err };
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
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] oauth start failed", {
            userId,
            connectorId,
            error: detail,
        });
        if (err instanceof ConnectorSetupError) {
            return { ok: false, kind: "setup", code: err.code, detail: err.message };
        }
        return { ok: false, kind: "failed", error: err };
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
        // Full message (with any embedded response body) goes to the log;
        // the user gets the concise diagnostic — never a raw HTML error
        // page — plus the versioned-endpoint hint for Google URLs.
        console.error("[user/mcp-connectors] refresh failed", {
            userId,
            connectorId,
            error: errorMessage(err),
        });
        if (err instanceof McpOAuthRequiredError) {
            return { ok: false, kind: "oauth_required", code: err.code };
        }
        return { ok: false, kind: "refresh_failed", error: err };
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
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] tool toggle failed", {
            userId,
            connectorId,
            toolId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}
