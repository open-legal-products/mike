// CourtListener as a connector, per workspace: the switch and the person's
// own token live in user_courtlistener_connections (see lib/providerCredentials/store.ts);
// an organization's token comes from org_api_keys and is laid over theirs.

import type { CourtListenerConnectorStatus } from "@mike/contracts";
import type { ConnectorOwner } from "../../lib/connectorOwner";
import { courtlistenerBulkDataEnabled } from "../../lib/courtlistener";
import {
    getEffectiveApiKeyStatus,
    getUserApiKeyStatus,
    loadCourtListenerConnection,
    saveCourtListenerConnection,
} from "../../lib/providerCredentials/index";
import type { Db } from "./user.shared";

export async function courtListenerConnectorStatus(
    db: Db,
    owner: ConnectorOwner,
): Promise<CourtListenerConnectorStatus> {
    const [connection, keys] = await Promise.all([
        loadCourtListenerConnection(owner, db),
        owner.orgId
            ? getEffectiveApiKeyStatus(owner.userId, owner.orgId, db)
            : getUserApiKeyStatus(owner.userId, db),
    ]);
    const source = keys.courtlistener ? keys.sources.courtlistener : null;
    const tokenSource = source === "user" || source === "org" ? source : null;
    const bulkData = courtlistenerBulkDataEnabled();
    const ownToken = !!connection.token;
    return {
        enabled: connection.enabled,
        // Listed under Installed while it is on and lookups can run, or while
        // the user has a token of their own here to manage. Switched off with
        // nothing of theirs saved, it goes back to Discover: the bulk index or
        // the organization's token was never something they added.
        installed:
            ownToken || (connection.enabled && (!!tokenSource || bulkData)),
        ownToken,
        tokenSource,
        bulkData,
    };
}

export async function setCourtListenerEnabled(
    db: Db,
    owner: ConnectorOwner,
    enabled: boolean,
): Promise<CourtListenerConnectorStatus> {
    await saveCourtListenerConnection(owner, { enabled }, db);
    return courtListenerConnectorStatus(db, owner);
}

/**
 * Save or (with null) delete the person's own token for the workspace.
 * Saving one is a request to use it, so it also turns the switch on, as
 * adding any other connector does.
 */
export async function setCourtListenerToken(
    db: Db,
    owner: ConnectorOwner,
    token: string | null,
): Promise<CourtListenerConnectorStatus> {
    const value = token?.trim() || null;
    await saveCourtListenerConnection(
        owner,
        value ? { token: value, enabled: true } : { token: null },
        db,
    );
    return courtListenerConnectorStatus(db, owner);
}
