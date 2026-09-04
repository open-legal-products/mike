import { describe, expect, it } from "vitest";
import {
    customMcpConnectors,
    isLegalDataHunterConnector,
    LEGAL_DATA_HUNTER_MCP,
} from "./legalDataHunterConnector";

const connector = (serverUrl: string) => ({ serverUrl });

describe("Legal Data Hunter connector identity", () => {
    it("matches only the built-in LDH endpoint", () => {
        expect(isLegalDataHunterConnector(connector(LEGAL_DATA_HUNTER_MCP.serverUrl))).toBe(
            true,
        );
        expect(
            isLegalDataHunterConnector(
                connector("https://legaldatahunter.com/mcp/"),
            ),
        ).toBe(false);
        expect(
            isLegalDataHunterConnector(connector("https://mcp.example.test/mcp")),
        ).toBe(false);
    });

    it("removes built-in LDH from the custom connector inventory", () => {
        const custom = connector("https://mcp.example.test/mcp");
        expect(
            customMcpConnectors([
                connector(LEGAL_DATA_HUNTER_MCP.serverUrl),
                custom,
            ]),
        ).toEqual([custom]);
    });
});
