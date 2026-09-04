import type { McpConnectorSummary } from "@/app/lib/mikeApi";

export const LEGAL_DATA_HUNTER_MCP = {
    name: "Legal Data Hunter",
    serverUrl: "https://legaldatahunter.com/mcp",
} as const;

export function isLegalDataHunterConnector(
    connector: Pick<McpConnectorSummary, "serverUrl">,
): boolean {
    return connector.serverUrl === LEGAL_DATA_HUNTER_MCP.serverUrl;
}

export function customMcpConnectors<
    T extends Pick<McpConnectorSummary, "serverUrl">,
>(connectors: readonly T[]): T[] {
    return connectors.filter(
        (connector) => !isLegalDataHunterConnector(connector),
    );
}
