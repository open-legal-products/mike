import type { McpConnectorSummary } from "@/app/lib/mikeApi";

export const LEGAL_DATA_HUNTER_MCP = {
    name: "Legal Data Hunter",
    serverUrl: "https://legaldatahunter.com/mcp",
} as const;

export function isLegalDataHunterConnector(
    connector: Pick<McpConnectorSummary, "serverUrl">,
): boolean {
    try {
        const url = new URL(connector.serverUrl);
        return (
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            `${url.origin}${url.pathname.replace(/\/+$/, "")}` ===
                LEGAL_DATA_HUNTER_MCP.serverUrl
        );
    } catch {
        return false;
    }
}

export function customMcpConnectors<
    T extends Pick<McpConnectorSummary, "serverUrl">,
>(connectors: readonly T[]): T[] {
    return connectors.filter(
        (connector) => !isLegalDataHunterConnector(connector),
    );
}
