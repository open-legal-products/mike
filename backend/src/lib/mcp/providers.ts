/**
 * Registry of MCP-server providers that need behavior beyond the OAuth spec.
 *
 * The MCP authorization spec assumes a well-behaved, self-describing server:
 * discovery metadata that matches reality, RFC 7591 dynamic client
 * registration, and standard authorization parameters. Real providers each
 * break those assumptions in their own way (Google needs proprietary
 * offline-access parameters and a manually created OAuth client; its metadata
 * advertises an endpoint path that returns an HTML error page). Rather than
 * scattering `if (isGoogle…)` branches through the OAuth flow and error
 * formatting, each divergence lives here as one table entry, and the rest of
 * the code asks the table.
 */

export type McpOAuthProviderQuirks = {
    /** Stable identifier, used in log lines. */
    id: string;
    /** Human name used in operator-facing messages. */
    displayName: string;
    /**
     * Hostname match for this provider's MCP servers. Receives a normalized
     * hostname: lowercased, with any trailing dot (the fully-qualified DNS
     * form `example.com.`) already stripped.
     */
    matches: (hostname: string) => boolean;
    /**
     * Environment-variable prefix for a pre-configured OAuth client
     * (`<prefix>_CLIENT_ID`, `<prefix>_CLIENT_SECRET`, `<prefix>_SCOPE`).
     */
    envPrefix: string;
    /**
     * Non-standard authorization-request query parameters the provider
     * requires. The MCP SDK builds a spec-compliant authorization URL and has
     * no hook for extras, so these are applied to the finished URL just before
     * the user is redirected to it.
     */
    authorizationParams?: Record<string, string>;
    /**
     * Set for providers that do NOT implement RFC 7591 dynamic client
     * registration. Returns the operator-facing setup instructions shown when
     * OAuth is attempted without a pre-configured client — including the
     * redirect URI so it can be copy-pasted into the provider's console.
     */
    setupInstructions?: (redirectUri: string) => string;
    /**
     * Optional hint appended to concise connector error messages, for
     * provider-specific traps (e.g. a wrong endpoint path that yields an
     * opaque generic error). Returns null when the error doesn't match the
     * trap.
     */
    endpointHint?: (url: URL, httpStatus: number) => string | null;
};

const PROVIDERS: McpOAuthProviderQuirks[] = [
    {
        id: "google",
        displayName: "Google",
        matches: (hostname) =>
            hostname === "googleapis.com" ||
            hostname.endsWith(".googleapis.com"),
        envPrefix: "GOOGLE_MCP_OAUTH",
        // Google only returns a refresh token when the request opts into
        // offline access (`access_type=offline`), and only re-issues one when
        // it is forced to re-prompt for consent (`prompt=consent`). Google
        // does not implement the OIDC `offline_access` scope that the SDK
        // would otherwise handle on its own, so these proprietary parameters
        // are the supported way to obtain a durable refresh token. Without
        // them a Google connector authorizes once and then breaks as soon as
        // the short-lived access token expires.
        authorizationParams: { access_type: "offline", prompt: "consent" },
        setupInstructions: (redirectUri) =>
            "Google MCP servers need a pre-configured OAuth client — Google does not " +
            "support automatic (dynamic) client registration. Create an OAuth client in " +
            "Google Cloud Console (APIs & Services → Credentials → Create credentials → " +
            `OAuth client ID → Web application) with authorized redirect URI ${redirectUri}, ` +
            "then set GOOGLE_MCP_OAUTH_CLIENT_ID and GOOGLE_MCP_OAUTH_CLIENT_SECRET in " +
            "backend/.env (see .env.example) and restart the backend.",
        // Google's MCP endpoints are versioned, and their discovery metadata
        // advertises the UNversioned path (`…/mcp`), so hitting the advertised
        // path yields an opaque generic 400. Users who copy the URL from the
        // metadata (or from Google's own docs) land exactly there.
        endpointHint: (url, httpStatus) =>
            (httpStatus === 400 || httpStatus === 404) &&
            !/\/v\d+(\/|$)/.test(url.pathname)
                ? "Google's MCP endpoints are versioned — check the server URL " +
                  "(for example the Drive MCP endpoint is " +
                  "https://drivemcp.googleapis.com/mcp/v1, not /mcp)."
                : null,
    },
];

/**
 * Normalizes a hostname for provider matching: lowercase, and without the
 * trailing "." of the fully-qualified, absolute DNS form (`googleapis.com.`
 * names the same host as `googleapis.com`; `URL` preserves that dot, and an
 * unstripped absolute form would silently skip every provider quirk).
 */
function normalizedHostname(serverUrl: string | URL): string | null {
    try {
        const url =
            serverUrl instanceof URL ? serverUrl : new URL(serverUrl);
        return url.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
        return null;
    }
}

export function mcpOAuthProviderFor(
    serverUrl: string | URL,
): McpOAuthProviderQuirks | null {
    const hostname = normalizedHostname(serverUrl);
    if (!hostname) return null;
    return PROVIDERS.find((provider) => provider.matches(hostname)) ?? null;
}
