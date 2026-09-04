import {
    getMcpConnector,
    startMcpConnectorOAuth,
} from "@/app/lib/mikeApi";

type McpOAuthPopupMessage = {
    type?: string;
    success?: boolean;
    connectorId?: string;
    detail?: string;
};

export type McpOAuthResult = "authorized" | "already_authorized" | "redirecting";

export async function authorizeMcpConnector(
    connectorId: string,
): Promise<McpOAuthResult> {
    const popup = window.open(
        "about:blank",
        `mike_mcp_oauth_${connectorId}_${crypto.randomUUID()}`,
        "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
    );

    try {
        const { authorizationUrl, alreadyAuthorized, callbackOrigin } =
            await startMcpConnectorOAuth(connectorId);
        if (alreadyAuthorized) {
            popup?.close();
            return "already_authorized";
        }
        if (!authorizationUrl) {
            throw new Error("OAuth authorization URL was not returned.");
        }

        const expectedCallbackOrigin = new URL(callbackOrigin).origin;
        if (!popup) {
            window.location.assign(authorizationUrl);
            return "redirecting";
        }
        popup.location.href = authorizationUrl;

        await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                cleanup();
                reject(new Error("OAuth authorization timed out."));
            }, 5 * 60 * 1000);
            const poll = window.setInterval(() => {
                if (popup.closed) {
                    cleanup();
                    void getMcpConnector(connectorId).then(
                        (connector) => {
                            if (connector.oauthConnected) {
                                resolve();
                                return;
                            }
                            reject(
                                new Error(
                                    "OAuth authorization window was closed.",
                                ),
                            );
                        },
                        () =>
                            reject(
                                new Error(
                                    "OAuth authorization window was closed.",
                                ),
                            ),
                    );
                }
            }, 700);
            const cleanup = () => {
                window.clearTimeout(timeout);
                window.clearInterval(poll);
                window.removeEventListener("message", onMessage);
            };
            const onMessage = (event: MessageEvent<McpOAuthPopupMessage>) => {
                if (event.origin !== expectedCallbackOrigin) return;
                if (event.source !== popup) return;
                if (event.data?.type !== "mcp_oauth_result") return;
                if (event.data.connectorId !== connectorId) return;
                const sourceWindow = event.source as Window | null;
                sourceWindow?.postMessage(
                    { type: "mcp_oauth_result_ack" },
                    event.origin,
                );
                cleanup();
                if (event.data.success) {
                    resolve();
                    return;
                }
                reject(
                    new Error(
                        event.data.detail || "OAuth authorization failed.",
                    ),
                );
            };
            window.addEventListener("message", onMessage);
        });

        popup.close();
        return "authorized";
    } catch (error) {
        popup?.close();
        throw error;
    }
}
