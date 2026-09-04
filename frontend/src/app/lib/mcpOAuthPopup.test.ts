import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeMcpConnector } from "./mcpOAuthPopup";

const startMcpConnectorOAuth = vi.hoisted(() => vi.fn());
const getMcpConnector = vi.hoisted(() => vi.fn());

vi.mock("@/app/lib/mikeApi", () => ({
    getMcpConnector,
    startMcpConnectorOAuth,
}));

function popupWindow() {
    return {
        closed: false,
        close: vi.fn(),
        postMessage: vi.fn(),
        location: { href: "about:blank" },
    } as unknown as Window;
}

describe("authorizeMcpConnector", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        startMcpConnectorOAuth.mockReset();
        getMcpConnector.mockReset();
    });

    it("closes the placeholder popup when authorization already exists", async () => {
        const popup = popupWindow();
        vi.spyOn(window, "open").mockReturnValue(popup);
        startMcpConnectorOAuth.mockResolvedValue({
            authorizationUrl: null,
            alreadyAuthorized: true,
            callbackOrigin: window.location.origin,
        });

        await expect(authorizeMcpConnector("connector-1")).resolves.toBe(
            "already_authorized",
        );
        expect(popup.close).toHaveBeenCalledOnce();
    });

    it("closes the placeholder popup when OAuth startup fails", async () => {
        const popup = popupWindow();
        vi.spyOn(window, "open").mockReturnValue(popup);
        startMcpConnectorOAuth.mockRejectedValue(new Error("network failed"));

        await expect(authorizeMcpConnector("connector-1")).rejects.toThrow(
            "network failed",
        );
        expect(popup.close).toHaveBeenCalledOnce();
    });

    it("accepts a matching OAuth callback and ignores other origins", async () => {
        const popup = popupWindow();
        vi.spyOn(window, "open").mockReturnValue(popup);
        startMcpConnectorOAuth.mockResolvedValue({
            authorizationUrl: "https://legaldatahunter.com/oauth/authorize",
            alreadyAuthorized: false,
            callbackOrigin: "https://mike.example.test",
        });

        const authorization = authorizeMcpConnector("connector-1");
        await Promise.resolve();
        await Promise.resolve();
        expect(popup.location.href).toBe(
            "https://legaldatahunter.com/oauth/authorize",
        );

        let settled = false;
        void authorization.then(() => {
            settled = true;
        });
        window.dispatchEvent(
            new MessageEvent("message", {
                origin: "https://attacker.example",
                source: popup,
                data: {
                    type: "mcp_oauth_result",
                    success: true,
                    connectorId: "connector-1",
                },
            }),
        );
        window.dispatchEvent(
            new MessageEvent("message", {
                origin: "https://mike.example.test",
                source: popup,
                data: {
                    type: "mcp_oauth_result",
                    success: true,
                },
            }),
        );
        window.dispatchEvent(
            new MessageEvent("message", {
                origin: "https://mike.example.test",
                source: window,
                data: {
                    type: "mcp_oauth_result",
                    success: true,
                    connectorId: "connector-1",
                },
            }),
        );
        await Promise.resolve();
        expect(settled).toBe(false);

        window.dispatchEvent(
            new MessageEvent("message", {
                origin: "https://mike.example.test",
                source: popup,
                data: {
                    type: "mcp_oauth_result",
                    success: true,
                    connectorId: "connector-1",
                },
            }),
        );

        await expect(authorization).resolves.toBe("authorized");
        expect(popup.close).toHaveBeenCalledOnce();
    });

    it("accepts durable OAuth completion when the popup closes before posting a message", async () => {
        vi.useFakeTimers();
        const popup = popupWindow();
        vi.spyOn(window, "open").mockReturnValue(popup);
        startMcpConnectorOAuth.mockResolvedValue({
            authorizationUrl: "https://legaldatahunter.com/oauth/authorize",
            alreadyAuthorized: false,
            callbackOrigin: "https://mike.example.test",
        });
        getMcpConnector.mockResolvedValue({ oauthConnected: true });

        const authorization = authorizeMcpConnector("connector-1");
        await Promise.resolve();
        await Promise.resolve();
        Object.assign(popup, { closed: true });
        await vi.advanceTimersByTimeAsync(700);

        await expect(authorization).resolves.toBe("authorized");
        expect(getMcpConnector).toHaveBeenCalledWith("connector-1");
        vi.useRealTimers();
    });
});
