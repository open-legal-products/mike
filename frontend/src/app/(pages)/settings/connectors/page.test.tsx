vi.mock("@/app/components/settings/GoogleWorkspacePanel", () => ({
    GoogleWorkspacePanel: ({ children, additionalConnectors }: { children: import("react").ReactNode; additionalConnectors?: import("react").ReactNode }) => <>{children}{additionalConnectors}</>,
}));

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectorsPage from "./page";
import {
    MikeApiError,
    type McpConnectorSummary,
    cancelGoogleDriveOAuth,
    createMcpConnector,
    deleteMcpConnector,
    disconnectGoogleDrive,
    getGoogleDriveStatus,
    getMcpConnector,
    listMcpConnectors,
    refreshMcpConnectorTools,
    startGoogleDriveOAuth,
    startMcpConnectorOAuth,
    updateMcpConnector,
} from "@/app/lib/mikeApi";
import { needsMfaVerification } from "@/app/components/popups/MfaVerificationPopup";

// Replace only the network functions the OAuth popup flow drives; keep the real
// MikeApiError / isMfaRequiredError so `instanceof` checks in the page behave.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return {
        ...actual,
        listMcpConnectors: vi.fn(),
        createMcpConnector: vi.fn(),
        deleteMcpConnector: vi.fn(),
        refreshMcpConnectorTools: vi.fn(),
        startMcpConnectorOAuth: vi.fn(),
        getMcpConnector: vi.fn(),
        updateMcpConnector: vi.fn(),
        getGoogleDriveStatus: vi.fn(() => new Promise(() => {})),
        startGoogleDriveOAuth: vi.fn(),
        cancelGoogleDriveOAuth: vi.fn(),
        disconnectGoogleDrive: vi.fn(),
    };
});

// MFA gate off, and render nothing for the popup itself.
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn(),
}));

function makeSummary(
    overrides: Partial<McpConnectorSummary> = {},
): McpConnectorSummary {
    return {
        id: "connector-1",
        name: "Drive",
        transport: "streamable_http",
        serverUrl: "https://drivemcp.googleapis.com/mcp",
        authType: "oauth",
        enabled: true,
        hasAuthConfig: false,
        customHeaderKeys: [],
        oauthConnected: false,
        toolPolicy: {},
        tools: [],
        toolCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

// Flush a generous number of microtask turns so the awaited create -> refresh
// -> startOAuth chain settles up to the point where the poll timer is armed.
async function flushMicrotasks() {
    for (let i = 0; i < 30; i += 1) {
        await Promise.resolve();
    }
}

// Drive the Add flow to the "auth" step, at which point the completion poll is
// running (getMcpConnector every 1.5s). Returns after the first poll has fired.
async function reachAuthStepAndFirstPoll() {
    render(<ConnectorsPage />);
    await act(async () => {
        await flushMicrotasks();
    });

    fireEvent.click(
        screen.getByRole("button", { name: "Add custom connector" }),
    );
    fireEvent.change(screen.getByPlaceholderText("Connector label"), {
        target: { value: "Drive" },
    });
    fireEvent.change(
        screen.getByPlaceholderText("https://mcp.example.com/mcp"),
        { target: { value: "https://drivemcp.googleapis.com/mcp" } },
    );

    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        await flushMicrotasks();
    });

    // Consent screen wording confirms we reached the auth step.
    expect(screen.getByText(/Authentication required/i)).toBeTruthy();

    // First poll fires at 1.5s.
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
    });
    expect(vi.mocked(getMcpConnector).mock.calls.length).toBeGreaterThanOrEqual(
        1,
    );
}

describe("ConnectorsPage OAuth poll cancellation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.mocked(createMcpConnector).mockResolvedValue({
            connector: makeSummary(),
            oauthRequired: true,
        });
        vi.mocked(deleteMcpConnector).mockResolvedValue(undefined);
        vi.mocked(refreshMcpConnectorTools).mockResolvedValue(makeSummary());
        vi.mocked(startMcpConnectorOAuth).mockResolvedValue({
            authorizationUrl: "https://auth.example/authorize",
            alreadyAuthorized: false,
            callbackOrigin: "https://api.example",
        });
        // Authorization never completes, so the poll keeps running until
        // something cancels it.
        vi.mocked(getMcpConnector).mockResolvedValue(
            makeSummary({ oauthConnected: false }),
        );

        // The flow opens a popup; hand back a controllable stub.
        vi.spyOn(window, "open").mockReturnValue({
            location: { href: "" },
            close: vi.fn(),
            closed: false,
        } as unknown as Window);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("stops polling when the component unmounts mid-authorization", async () => {
        await reachAuthStepAndFirstPoll();
        const callsBefore = vi.mocked(getMcpConnector).mock.calls.length;

        cleanup(); // unmount

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        // No further authenticated reads after unmount — the AbortController in
        // the unmount cleanup tore the poll down.
        expect(vi.mocked(getMcpConnector).mock.calls.length).toBe(callsBefore);
    });

    it("stops polling and closes the modal when the user cancels", async () => {
        await reachAuthStepAndFirstPoll();
        const callsBefore = vi.mocked(getMcpConnector).mock.calls.length;

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
            await flushMicrotasks();
        });

        // Modal left the auth step.
        expect(screen.queryByText(/Authentication required/i)).toBeNull();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(vi.mocked(getMcpConnector).mock.calls.length).toBe(callsBefore);
    });

    it("lets the user cancel a stuck reconnect instead of waiting out the timeout", async () => {
        // The details modal's Refresh flow reuses the same OAuth popup wait as
        // the add flow, but used to offer no way out: with COOP hiding the
        // popup's fate, closing the consent window left the Refresh button
        // stuck busy for the full five-minute timeout.
        vi.mocked(listMcpConnectors).mockResolvedValue([makeSummary()]);
        vi.mocked(refreshMcpConnectorTools).mockRejectedValueOnce(
            new MikeApiError({
                message: "Authorization required.",
                status: 409,
                code: "oauth_required",
            }),
        );
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        // The card itself opens the modal: there is no per-card Details button.
        expect(screen.queryByRole("button", { name: "Details" })).toBeNull();

        await act(async () => {
            fireEvent.click(screen.getByText("Drive"));
            await flushMicrotasks();
        });

        expect(document.querySelector("[data-connector-placeholder]")).toBeTruthy();

        // A custom connector opens on Details; the tool list and its Refresh
        // live behind the Tools tab.
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Tools" }));
            await flushMicrotasks();
        });

        // Refresh hits the oauth_required branch and starts the popup wait.
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
            await flushMicrotasks();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
        });
        const callsBefore = vi.mocked(getMcpConnector).mock.calls.length;
        expect(callsBefore).toBeGreaterThanOrEqual(1);

        // The reconnect flow now surfaces a Cancel affordance; use it.
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
            await flushMicrotasks();
        });

        // The poll is torn down…
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(vi.mocked(getMcpConnector).mock.calls.length).toBe(callsBefore);

        // …the button is immediately usable again, and a deliberate cancel is
        // not surfaced as an error.
        const refreshButton = screen.getByRole("button", {
            name: /refresh/i,
        }) as HTMLButtonElement;
        expect(refreshButton.disabled).toBe(false);
        expect(screen.queryByText(/cancelled/i)).toBeNull();
    });

    it("opens a preset-free custom connector form with modal inputs", async () => {
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        fireEvent.click(
            screen.getByRole("button", { name: "Add custom connector" }),
        );

        expect(screen.getByText("New Custom Connector")).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: /slack mcp\.slack\.com/i }),
        ).toBeNull();
        const nameInput = screen.getByPlaceholderText("Connector label");
        const urlInput = screen.getByPlaceholderText(
            "https://mcp.example.com/mcp",
        );
        expect((nameInput as HTMLInputElement).value).toBe("");
        expect((urlInput as HTMLInputElement).value).toBe("");
        expect(nameInput.className).toContain("liquid-glass-subtle");
        expect(urlInput.className).toContain("liquid-glass-subtle");
    });

    it("surfaces custom connector failures in the warning popup", async () => {
        vi.mocked(createMcpConnector).mockRejectedValueOnce(
            new MikeApiError({
                message: "The connector URL could not be reached.",
                status: 400,
                code: "invalid_connector",
            }),
        );

        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Add custom connector" }),
        );
        fireEvent.change(screen.getByPlaceholderText("Connector label"), {
            target: { value: "Custom" },
        });
        fireEvent.change(
            screen.getByPlaceholderText("https://mcp.example.com/mcp"),
            { target: { value: "https://custom.example/mcp" } },
        );

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Connect" }));
            await flushMicrotasks();
        });

        const warning = screen.getByRole("alert");
        expect(warning.textContent).toContain("Could not add connector");
        expect(warning.textContent).toContain(
            "The connector URL could not be reached.",
        );
        expect(
            screen.queryByRole("link", {
                name: "Open connector setup guide",
            }),
        ).toBeNull();
    });

    it("keeps an incomplete connector visible when client cleanup fails", async () => {
        const connector = makeSummary({
            name: "Custom",
            serverUrl: "https://custom.example/mcp",
        });
        vi.mocked(createMcpConnector).mockResolvedValueOnce({
            connector,
            oauthRequired: true,
        });
        vi.mocked(startMcpConnectorOAuth).mockRejectedValueOnce(
            new Error("Authorization failed"),
        );
        vi.mocked(deleteMcpConnector).mockRejectedValueOnce(
            new Error("Delete failed"),
        );

        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Add custom connector" }),
        );
        fireEvent.change(screen.getByPlaceholderText("Connector label"), {
            target: { value: "Custom" },
        });
        fireEvent.change(
            screen.getByPlaceholderText("https://mcp.example.com/mcp"),
            { target: { value: "https://custom.example/mcp" } },
        );

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Connect" }));
            await flushMicrotasks();
        });

        expect(screen.getByRole("alert").textContent).toContain(
            "could not be removed",
        );
        expect(
            screen.getByRole("switch", { name: "Custom connector" }),
        ).toBeTruthy();
    });

    it("reloads Installed when backend cleanup leaves a connector behind", async () => {
        const connector = makeSummary({
            name: "Retained connector",
            serverUrl: "https://retained.example/mcp",
        });
        vi.mocked(listMcpConnectors)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([connector]);
        vi.mocked(createMcpConnector).mockRejectedValueOnce(
            new MikeApiError({
                message:
                    "Connector validation failed, and the incomplete connector could not be removed. Remove it from Installed before trying again.",
                status: 409,
                code: "connector_cleanup_failed",
            }),
        );

        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Add custom connector" }),
        );
        fireEvent.change(screen.getByPlaceholderText("Connector label"), {
            target: { value: "Retained connector" },
        });
        fireEvent.change(
            screen.getByPlaceholderText("https://mcp.example.com/mcp"),
            { target: { value: "https://retained.example/mcp" } },
        );

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Connect" }));
            await flushMicrotasks();
        });

        expect(listMcpConnectors).toHaveBeenCalledTimes(2);
        expect(
            screen.getByRole("switch", { name: "Retained connector connector" }),
        ).toBeTruthy();
    });
});

describe("ConnectorsPage operator setup guidance", () => {
    const popupClose = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.mocked(startMcpConnectorOAuth).mockResolvedValue({
            authorizationUrl: null,
            alreadyAuthorized: true,
            callbackOrigin: "https://api.example",
        });
        vi.spyOn(window, "open").mockReturnValue({
            location: { href: "" },
            close: vi.fn(),
            closed: false,
        } as unknown as Window);
        vi.spyOn(window, "open").mockReturnValue({
            location: { href: "" },
            close: popupClose,
            closed: false,
        } as unknown as Window);
    });

    afterEach(() => {
        cleanup();
    });

    it("shows provider setup guidance before a Slack connector is installed", async () => {
        // The create endpoint performs this deployment check before inserting
        // a row, so the client never refreshes tools or opens an OAuth popup.
        const instructions =
            "Slack MCP requires administrator setup because Slack does not support dynamic client registration.";
        vi.mocked(createMcpConnector).mockRejectedValue(
            new MikeApiError({
                message: instructions,
                status: 400,
                code: "connector_setup_required",
            }),
        );

        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", { name: "Add Slack connector" }),
            );
            await flushMicrotasks();
        });

        const notice = screen.getByRole("alert");
        expect(notice.textContent).toContain("Could not add connector");
        expect(notice.textContent).toContain("administrator setup");
        expect(notice.textContent).not.toContain("localhost");
        expect(
            screen.getByRole("link", { name: "Open connector setup guide" }),
        ).toHaveAttribute(
            "href",
            "https://github.com/open-legal-products/mike/blob/main/docs/connectors.md#slack",
        );
        expect(refreshMcpConnectorTools).not.toHaveBeenCalled();
        expect(startMcpConnectorOAuth).not.toHaveBeenCalled();
        expect(deleteMcpConnector).not.toHaveBeenCalled();
        // Discover never opens the custom connector modal and no connector
        // was inserted to appear in Installed.
        expect(screen.queryByText(/failed to add connector/i)).toBeNull();
        expect(screen.queryByText("New Custom Connector")).toBeNull();
        expect(
            screen.queryByRole("button", { name: /delete connector/i }),
        ).toBeNull();
        expect(window.open).not.toHaveBeenCalled();
        expect(popupClose).not.toHaveBeenCalled();
    });
});

describe("ConnectorsPage suggested connectors", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.mocked(startMcpConnectorOAuth).mockResolvedValue({
            authorizationUrl: null,
            alreadyAuthorized: true,
            callbackOrigin: "https://api.example",
        });
        vi.spyOn(window, "open").mockReturnValue({
            location: { href: "" },
            close: vi.fn(),
            closed: false,
        } as unknown as Window);
    });

    afterEach(() => {
        cleanup();
    });

    it("adds the Notion preset with one click", async () => {
        const notion = makeSummary({
            id: "notion-1",
            name: "Notion",
            serverUrl: "https://mcp.notion.com/mcp",
            authType: "none",
        });
        vi.mocked(createMcpConnector).mockResolvedValue({
            connector: notion,
            oauthRequired: true,
        });
        vi.mocked(refreshMcpConnectorTools).mockResolvedValue(notion);

        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        const configuredHeading = screen.getByRole("heading", {
            name: "Installed",
        });
        const suggestedHeading = screen.getByRole("heading", {
            name: "Discover",
        });
        expect(
            configuredHeading.compareDocumentPosition(suggestedHeading) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", {
                    name: "Add Notion connector",
                }),
            );
            await flushMicrotasks();
        });

        expect(createMcpConnector).toHaveBeenCalledWith({
            name: "Notion",
            serverUrl: "https://mcp.notion.com/mcp",
            bearerToken: null,
        });
        expect(startMcpConnectorOAuth).toHaveBeenCalledWith("notion-1");
        expect(refreshMcpConnectorTools).toHaveBeenCalledTimes(1);
        expect(screen.queryByText("Connector added")).toBeNull();
        expect(
            screen.getByRole("button", { name: "Notion connector added" }),
        ).toBeDisabled();
    });

    it("adds the Airtable DCR preset with one click", async () => {
        const airtable = makeSummary({
            id: "airtable-1",
            name: "Airtable",
            serverUrl: "https://mcp.airtable.com/mcp",
            authType: "oauth",
        });
        vi.mocked(createMcpConnector).mockResolvedValue({
            connector: airtable,
            oauthRequired: true,
        });
        vi.mocked(refreshMcpConnectorTools).mockResolvedValue(airtable);

        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", {
                    name: "Add Airtable connector",
                }),
            );
            await flushMicrotasks();
        });

        expect(createMcpConnector).toHaveBeenCalledWith({
            name: "Airtable",
            serverUrl: "https://mcp.airtable.com/mcp",
            bearerToken: null,
        });
        expect(startMcpConnectorOAuth).toHaveBeenCalledWith("airtable-1");
        expect(refreshMcpConnectorTools).toHaveBeenCalledTimes(1);
        expect(
            screen.getByRole("button", { name: "Airtable connector added" }),
        ).toBeDisabled();
    });

    it("adds the Linear DCR preset with one click", async () => {
        const linear = makeSummary({
            id: "linear-1",
            name: "Linear",
            serverUrl: "https://mcp.linear.app/mcp",
            authType: "oauth",
        });
        vi.mocked(createMcpConnector).mockResolvedValue({
            connector: linear,
            oauthRequired: true,
        });
        vi.mocked(refreshMcpConnectorTools).mockResolvedValue({
            ...linear,
            oauthConnected: true,
        });
        vi.mocked(startMcpConnectorOAuth).mockResolvedValue({
            authorizationUrl: null,
            alreadyAuthorized: true,
            callbackOrigin: "https://api.example",
        });
        const popupClose = vi.fn();
        vi.spyOn(window, "open").mockReturnValue({
            location: { href: "" },
            close: popupClose,
            closed: false,
        } as unknown as Window);

        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(
                screen.getByRole("button", {
                    name: "Add Linear connector",
                }),
            );
            await flushMicrotasks();
        });

        expect(createMcpConnector).toHaveBeenCalledWith({
            name: "Linear",
            serverUrl: "https://mcp.linear.app/mcp",
            bearerToken: null,
        });
        expect(startMcpConnectorOAuth).toHaveBeenCalledWith("linear-1");
        expect(popupClose).toHaveBeenCalled();
        expect(screen.queryByText("New Custom Connector")).toBeNull();
        expect(
            screen.getByRole("button", { name: "Linear connector added" }),
        ).toBeDisabled();
    });

    it("does not offer to add a preset that is already configured", async () => {
        vi.mocked(listMcpConnectors).mockResolvedValue([
            makeSummary({
                name: "My Notion",
                serverUrl: "https://mcp.notion.com/mcp/",
            }),
        ]);

        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        expect(
            screen.getByRole("button", { name: "Notion connector added" }),
        ).toBeDisabled();
        expect(createMcpConnector).not.toHaveBeenCalled();
        expect(
            screen.getByRole("switch", { name: "My Notion connector" }),
        ).toBeTruthy();
        expect(screen.queryByText("Enabled")).toBeNull();
        expect(screen.queryByText("Disabled")).toBeNull();

        fireEvent.keyDown(
            screen.getByRole("switch", { name: "My Notion connector" }),
            { key: " " },
        );
        expect(getMcpConnector).not.toHaveBeenCalled();
    });
});

describe("ConnectorsPage details autosave", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([makeSummary()]);
        vi.mocked(getMcpConnector).mockResolvedValue(makeSummary());
        vi.mocked(refreshMcpConnectorTools).mockResolvedValue(makeSummary());
    });

    afterEach(() => {
        vi.useRealTimers();
        cleanup();
    });

    async function openDetailsAndRename(name: string) {
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
        await act(async () => {
            fireEvent.click(screen.getByText("Drive"));
            await flushMicrotasks();
        });
        fireEvent.change(screen.getByPlaceholderText("Connector label"), {
            target: { value: name },
        });
    }

    it("commits a settled edit without a Save button", async () => {
        vi.mocked(updateMcpConnector).mockResolvedValue(
            makeSummary({
                name: "Renamed",
                serverUrl: "https://custom.example/mcp",
            }),
        );

        await openDetailsAndRename("Renamed");

        // The footer offers Delete only; the edit commits on its own.
        expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
        expect(updateMcpConnector).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
            await flushMicrotasks();
        });

        expect(updateMcpConnector).toHaveBeenCalledWith(
            "connector-1",
            expect.objectContaining({ name: "Renamed" }),
        );
    });

    it("preserves edits made while an autosave request is in flight", async () => {
        let resolveSave!: (connector: McpConnectorSummary) => void;
        vi.mocked(updateMcpConnector).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveSave = resolve;
                }),
        );

        await openDetailsAndRename("First edit");
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
        });
        expect(updateMcpConnector).toHaveBeenCalledTimes(1);

        fireEvent.change(screen.getByPlaceholderText("Connector label"), {
            target: { value: "Newer edit" },
        });
        await act(async () => {
            resolveSave(makeSummary({ name: "First edit" }));
            await flushMicrotasks();
        });

        expect(
            (screen.getByPlaceholderText("Connector label") as HTMLInputElement)
                .value,
        ).toBe("Newer edit");
    });

    it("waits for custom headers to become valid JSON before autosaving", async () => {
        vi.mocked(updateMcpConnector).mockResolvedValue(
            makeSummary({ name: "Renamed" }),
        );
        await openDetailsAndRename("Renamed");
        fireEvent.change(screen.getByPlaceholderText('{"X-API-Key":"secret"}'), {
            target: { value: '{"X-API-Key":' },
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
        });
        expect(updateMcpConnector).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).toBeNull();

        fireEvent.change(screen.getByPlaceholderText('{"X-API-Key":"secret"}'), {
            target: { value: '{"X-API-Key":"secret"}' },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
            await flushMicrotasks();
        });
        expect(updateMcpConnector).toHaveBeenCalledTimes(1);
    });
});

describe("Google Drive connection lifecycle", () => {
    const ready = {
        connected: false,
        scope: null,
        configured: true,
        schemaReady: true,
        redirectUri: null,
    };
    const state = "a".repeat(32);

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.mocked(getGoogleDriveStatus).mockResolvedValue(ready);
        vi.mocked(startGoogleDriveOAuth).mockResolvedValue({
            authorizationUrl: `https://accounts.google.com/authorize?state=${state}`,
        });
        vi.mocked(cancelGoogleDriveOAuth).mockResolvedValue(undefined);
        vi.mocked(disconnectGoogleDrive).mockResolvedValue(undefined);
        vi.spyOn(window, "open").mockReturnValue({
            location: { href: "" },
            close: vi.fn(),
            closed: false,
        } as unknown as Window);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    async function openCard() {
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        expect(screen.queryByRole("dialog", { name: "Google Drive" })).toBeNull();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Add Google Drive" }));
            await flushMicrotasks();
        });
    }

    it("shows the redirect URI when Drive is not configured", async () => {
        vi.mocked(getGoogleDriveStatus).mockResolvedValue({
            ...ready,
            configured: false,
            redirectUri:
                "http://localhost:3000/api/user/integrations/google-drive/oauth/callback",
        });

        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        fireEvent.click(screen.getByRole("button", { name: "Set up Google Drive" }));

        expect(
            screen.getByText(
                /administrator needs to configure a Google OAuth client/i,
            ),
        ).toBeTruthy();
        expect(
            screen.getByText(
                "http://localhost:3000/api/user/integrations/google-drive/oauth/callback",
            ),
        ).toBeTruthy();
        expect(
            (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it("names the missing migration without blaming OAuth configuration", async () => {
        vi.mocked(getGoogleDriveStatus).mockResolvedValue({
            ...ready,
            schemaReady: false,
        });

        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        fireEvent.click(screen.getByRole("button", { name: "Set up Google Drive" }));

        expect(
            screen.getByText(/missing the Google Drive migration/i),
        ).toBeTruthy();
        expect(
            screen.queryByText(
                /administrator needs to configure a Google OAuth client/i,
            ),
        ).toBeNull();
        expect(
            (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it("polls successful consent and disconnects without leaving a pending attempt", async () => {
        await openCard();
        vi.mocked(getGoogleDriveStatus).mockResolvedValue({
            ...ready,
            connected: true,
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
        });
        fireEvent.click(screen.getByRole("button", { name: "Manage Google Drive" }));
        expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
        expect(cancelGoogleDriveOAuth).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
            await flushMicrotasks();
        });
        expect(disconnectGoogleDrive).toHaveBeenCalledOnce();
        expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    });

    it("cancels the server-side attempt and stops polling", async () => {
        await openCard();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Cancel Google Drive authorization" }));
            await flushMicrotasks();
        });
        expect(cancelGoogleDriveOAuth).toHaveBeenCalledWith(state);
        expect(screen.getByText("Authorization cancelled.")).toBeTruthy();
        const count = vi.mocked(getGoogleDriveStatus).mock.calls.length;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10000);
        });
        expect(getGoogleDriveStatus).toHaveBeenCalledTimes(count);
    });

    it("starts OAuth directly and cancels pending consent from the card", async () => {
        await openCard();
        fireEvent.click(screen.getByRole("button", { name: "Cancel Google Drive authorization" }));
        await act(flushMicrotasks);
        expect(cancelGoogleDriveOAuth).toHaveBeenCalledWith(state);
        expect(screen.queryByRole("dialog", { name: "Google Drive" })).toBeNull();
        expect(screen.getByRole("button", { name: "Add Google Drive" })).toBeEnabled();
    });

    it("honors cancellation while the start request is still in flight", async () => {
        let resolveStart!: (value: { authorizationUrl: string }) => void;
        vi.mocked(startGoogleDriveOAuth).mockReturnValue(
            new Promise((resolve) => {
                resolveStart = resolve;
            }),
        );
        await openCard();
        fireEvent.click(screen.getByRole("button", { name: "Cancel Google Drive authorization" }));
        await act(async () => {
            resolveStart({
                authorizationUrl: `https://accounts.google.com/authorize?state=${state}`,
            });
            await flushMicrotasks();
        });
        expect(cancelGoogleDriveOAuth).toHaveBeenCalledWith(state);
        expect(screen.getByRole("button", { name: "Add Google Drive" })).toBeTruthy();
    });

    it("shows a completed connection if consent wins the cancellation race", async () => {
        await openCard();
        vi.mocked(getGoogleDriveStatus).mockResolvedValue({
            ...ready,
            connected: true,
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Cancel Google Drive authorization" }));
            await flushMicrotasks();
        });
        fireEvent.click(screen.getByRole("button", { name: "Manage Google Drive" }));
        expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    });

    it("hides unexpected connection errors", async () => {
        vi.mocked(startGoogleDriveOAuth).mockRejectedValue(
            new Error("internal-sentinel"),
        );
        await openCard();
        expect(screen.getByText("Failed to connect Google Drive.")).toBeTruthy();
        expect(screen.queryByText(/internal-sentinel/)).toBeNull();
    });

    it("reports a status outage honestly", async () => {
        vi.mocked(getGoogleDriveStatus).mockRejectedValue(
            new Error("internal-sentinel"),
        );
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        fireEvent.click(screen.getByRole("button", { name: "Set up Google Drive" }));
        expect(
            screen.getByText(/Could not load Google Drive status/),
        ).toBeTruthy();
        expect(screen.queryByText(/administrator needs to configure/)).toBeNull();
        expect(screen.queryByText(/internal-sentinel/)).toBeNull();
    });
});
