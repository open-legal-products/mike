// mcpJobs — implementation behind the module facade.
import { McpOAuthRequiredError, loadOAuthToken, refreshOAuthAccessToken } from "../../lib/mcp/oauth";
import { type Db, type DbJob } from "../../lib/dbq/types";

/**
 * Refresh an MCP OAuth access token that is about to expire.
 *
 * The lazy refresh in oauthBearerToken stays the last line of defense; this
 * job just moves the cost (and the failure) off the request that would
 * otherwise discover the expiry mid-tool-call.
 */
export const MCP_TOKEN_REFRESH_WINDOW_MS = 15 * 60 * 1000;

export async function handleMcpRefreshToken(
    db: Db,
    job: DbJob,
): Promise<void> {
    const connectorId = job.payload.connectorId as string | undefined;
    if (!connectorId) return; // malformed payload — nothing to retry into

    const token = await loadOAuthToken(connectorId, db);
    // The connector was disconnected (rows cascade-delete) or never held an
    // OAuth grant between the sweep and this run: nothing to refresh, and a
    // retry cannot bring the row back.
    if (!token?.encrypted_access_token || !token.encrypted_refresh_token) {
        return;
    }

    // Idempotency, and the whole point of re-checking here: a concurrent
    // request may already have taken the lazy-refresh path, or an earlier
    // attempt of this very job may have succeeded and then failed to report
    // it. A token that is no longer near expiry needs nothing.
    const expiresAt = token.expires_at ? Date.parse(token.expires_at) : null;
    if (!expiresAt || expiresAt > Date.now() + MCP_TOKEN_REFRESH_WINDOW_MS) {
        return;
    }

    try {
        // refreshOAuthAccessToken owns its own persistence (it upserts the
        // new token through storeOAuthToken), so there is nothing to write
        // here — reusing it is what keeps the two refresh paths identical.
        await refreshOAuthAccessToken(token, db);
    } catch (err) {
        // A dead grant (invalid_grant and friends) cannot be retried into
        // life: only the user reconnecting fixes it. Burning the attempt
        // budget replaying it would just spam the authorization server, so
        // swallow it and let the lazy path surface "reconnect" in the UI the
        // next time the user actually touches this connector.
        if (err instanceof McpOAuthRequiredError && err.permanent) {
            console.warn(
                "[mcp.refresh_token] permanent refresh failure; user must reconnect",
                { connectorId, oauthErrorCode: err.oauthErrorCode },
            );
            return;
        }
        // Everything else — transport errors, 5xx/429 from the authorization
        // server — is worth another attempt.
        throw err;
    }
}
