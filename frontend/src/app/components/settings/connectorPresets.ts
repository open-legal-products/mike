export const CONNECTOR_PRESETS: ReadonlyArray<{
    name: string;
    serverUrl: string;
}> = [
    { name: "Slack", serverUrl: "https://mcp.slack.com/mcp" },
    { name: "Notion", serverUrl: "https://mcp.notion.com/mcp" },
    { name: "Airtable", serverUrl: "https://mcp.airtable.com/mcp" },
    { name: "Linear", serverUrl: "https://mcp.linear.app/mcp" },
    { name: "Lawve", serverUrl: "https://mcp.lawve.ai" },
];

/**
 * Preset URLs and stored connector URLs differ in trailing slashes and
 * fragments, so every comparison between the two goes through this.
 */
export function normalizedServerUrl(serverUrl: string) {
    try {
        const url = new URL(serverUrl);
        url.hash = "";
        url.pathname = url.pathname.replace(/\/$/, "") || "/";
        return url.toString();
    } catch {
        return serverUrl.trim();
    }
}

/**
 * The preset a connector was installed from, or undefined when its URL matches
 * none of them — which is what makes a connector "custom".
 */
export function findConnectorPreset(serverUrl: string) {
    return CONNECTOR_PRESETS.find(
        (candidate) =>
            normalizedServerUrl(candidate.serverUrl) ===
            normalizedServerUrl(serverUrl),
    );
}
