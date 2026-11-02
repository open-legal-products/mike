// Access tokens for Google Vertex AI service accounts.
//
// One auth client is kept per service-account key so its access token (valid
// for an hour) is reused across requests instead of being re-minted for every
// model call. The client is built from the parsed key's email and private key
// only, so the token exchange always goes to Google's own endpoint whatever
// the uploaded key file claims.

import crypto from "crypto";
import type { JWT } from "google-auth-library";
import type { VertexServiceAccount } from "./cloudProviders";

const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const MAX_CACHED_CLIENTS = 200;

// Keyed by a digest of the key itself: a replaced or removed key can no
// longer reach its cached client.
const clients = new Map<string, JWT>();

function fingerprint(account: VertexServiceAccount): string {
    return crypto
        .createHash("sha256")
        .update(account.clientEmail)
        .update("\0")
        .update(account.privateKey)
        .digest("hex");
}

export async function vertexAuthClient(
    account: VertexServiceAccount,
): Promise<JWT> {
    const key = fingerprint(account);
    const cached = clients.get(key);
    if (cached) return cached;

    const { JWT } = await import("google-auth-library");
    const client = new JWT({
        email: account.clientEmail,
        key: account.privateKey,
        ...(account.privateKeyId ? { keyId: account.privateKeyId } : {}),
        scopes: [VERTEX_SCOPE],
    });
    if (clients.size >= MAX_CACHED_CLIENTS) {
        const oldest = clients.keys().next().value;
        if (oldest !== undefined) clients.delete(oldest);
    }
    clients.set(key, client);
    return client;
}

/** Test seam — clients otherwise live for the process lifetime. */
export function resetVertexAuthClients(): void {
    clients.clear();
}
