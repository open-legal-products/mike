// MCP connectors: thin {ok,...}|{ok:false,detail} wrappers over
// lib/mcpConnectors.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. The OAuth callback exchange (completeUserMcpConnectorOAuth) stays
// in the route: it is inseparable from the popup-HTML/CSP response it renders.

import {
    createUserMcpConnector,
    deleteUserMcpConnector,
    getUserMcpConnector,
    listUserMcpConnectors,
    McpOAuthRequiredError,
    refreshUserMcpConnectorTools,
    setUserMcpToolEnabled,
    startUserMcpConnectorOAuth,
    updateUserMcpConnector,
} from "../../lib/mcpConnectors";
import { type Db, errorMessage } from "./user.shared";

export async function listMcpConnectors(
    db: Db,
    userId: string,
): Promise<{ ok: true; connectors: unknown } | { ok: false; error: unknown }> {
    try {
        const connectors = await listUserMcpConnectors(userId, db, {
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
    userId: string,
    params: {
        name: string;
        serverUrl: string;
        bearerToken: string | null;
        headers: Record<string, unknown> | undefined;
    },
): Promise<{ ok: true; connector: unknown } | { ok: false; error: unknown }> {
    try {
        const connector = await createUserMcpConnector(userId, params, db);
        return { ok: true, connector };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] create failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
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
    | { ok: false; error: unknown }
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
        return { ok: false, error: err };
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
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] refresh failed", {
            userId,
            connectorId,
            error: detail,
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
