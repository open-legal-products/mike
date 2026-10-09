import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    getGoogleWorkspaceStatus,
    getMcpConnector,
    listMcpConnectors,
    refreshMcpConnectorTools,
    setGoogleWorkspaceToolEnabled,
    setGoogleDriveToolEnabled,
    setMcpToolEnabled,
    startGoogleDriveOAuth,
    startMcpConnectorOAuth,
    updateGoogleDriveSettings,
    updateGoogleWorkspaceSettings,
    updateMcpConnector,
} from "@/app/lib/mikeApi";
import type { GoogleWorkspaceStatus } from "@mike/contracts";
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
        setMcpToolEnabled: vi.fn(),
        getGoogleDriveStatus: vi.fn(() => new Promise(() => {})),
        startGoogleDriveOAuth: vi.fn(),
        cancelGoogleDriveOAuth: vi.fn(),
        disconnectGoogleDrive: vi.fn(),
        updateGoogleDriveSettings: vi.fn(),
        setGoogleDriveToolEnabled: vi.fn(),
        getGoogleWorkspaceStatus: vi.fn(() => new Promise(() => {})),
        updateGoogleWorkspaceSettings: vi.fn(),
        setGoogleWorkspaceToolEnabled: vi.fn(),
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
        requireWriteApproval: false,
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
        // Once installed, the preset leaves Discover.
        expect(
            screen.queryByRole("button", { name: "Add Notion connector" }),
        ).toBeNull();
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
        // Once installed, the preset leaves Discover.
        expect(
            screen.queryByRole("button", { name: "Add Airtable connector" }),
        ).toBeNull();
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
        // Once installed, the preset leaves Discover.
        expect(
            screen.queryByRole("button", { name: "Add Linear connector" }),
        ).toBeNull();
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

        // Once installed, the preset leaves Discover.
        expect(
            screen.queryByRole("button", { name: "Add Notion connector" }),
        ).toBeNull();
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

const driveTools = [
    {
        name: "google_drive_search",
        title: "Search files",
        description: "Search Drive.",
        write: false,
        enabled: true,
    },
];

describe("Google Drive connection lifecycle", () => {
    const ready = {
        writeEnabled: false,
        requireWriteApproval: false,
        connected: false,
        scope: null,
        configured: true,
        schemaReady: true,
        redirectUri: null,
        enabled: true,
        tools: driveTools,
    };
    const state = "a".repeat(32);

    it("saves Drive approval and tool settings", async () => {
        const status = {
            ...ready, connected: true, writeEnabled: true, grantId: "drive-grant",
            tools: [...driveTools, { name: "google_drive_trash_file", title: "Move to Trash", description: "Trash a file.", write: true, enabled: true }],
        };
        vi.mocked(getGoogleDriveStatus).mockResolvedValue(status);
        vi.mocked(updateGoogleDriveSettings).mockResolvedValue({ ...status, requireWriteApproval: true });
        vi.mocked(setGoogleDriveToolEnabled).mockResolvedValue({ ...status, requireWriteApproval: true, tools: status.tools.map((t) => ({ ...t, enabled: !t.write })) });
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        fireEvent.click(screen.getByRole("button", { name: "Manage Google Drive" }));
        const dialog = within(screen.getByRole("dialog"));
        await act(async () => {
            fireEvent.click(dialog.getByRole("switch", { name: "Ask for permission for write actions" }));
            await flushMicrotasks();
        });
        expect(updateGoogleDriveSettings).toHaveBeenCalledWith({ requireWriteApproval: true });
        await act(async () => {
            fireEvent.click(dialog.getByRole("switch", { name: "Move to Trash enabled" }));
            await flushMicrotasks();
        });
        expect(setGoogleDriveToolEnabled).toHaveBeenCalledWith("google_drive_trash_file", false);
    });

    let popup: { location: { href: string }; close: ReturnType<typeof vi.fn> };

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
        popup = { location: { href: "" }, close: vi.fn() };
        vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const discover = () =>
        within(screen.getByRole("region", { name: "Discover" }));
    const installed = () =>
        within(screen.getByRole("region", { name: "Installed" }));

    async function clickAdd() {
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        await act(async () => {
            fireEvent.click(
                discover().getByRole("button", {
                    name: "Add Google Drive connector",
                }),
            );
            await flushMicrotasks();
        });
    }

    it("shows the server's setup steps in the same warning as Slack", async () => {
        vi.mocked(startGoogleDriveOAuth).mockRejectedValue(
            new MikeApiError({
                message:
                    "Google Drive needs an OAuth client. Register http://localhost:3000/api/user/integrations/google-drive/oauth/callback.",
                status: 400,
                code: "connector_setup_required",
            }),
        );
        await clickAdd();

        expect(screen.getByText("Could not add connector")).toBeTruthy();
        expect(
            screen.getByText(
                /Google Drive needs an OAuth client\. Register http:\/\/localhost:3000/,
            ),
        ).toBeTruthy();
        expect(
            screen.getByRole("link", { name: /setup guide/i }),
        ).toHaveAttribute("href", expect.stringContaining("google-drive.md"));
        // The blank window opened for the flow is closed again.
        expect(popup.close).toHaveBeenCalled();
        expect(
            discover().getByRole("button", {
                name: "Add Google Drive connector",
            }),
        ).toBeEnabled();
    });

    it("names the missing migration without contacting Google", async () => {
        vi.mocked(getGoogleDriveStatus).mockResolvedValue({
            ...ready,
            schemaReady: false,
        });
        await clickAdd();

        expect(screen.getByText("Could not add connector")).toBeTruthy();
        expect(
            screen.getByText(/apply the Google Drive database migration/i),
        ).toBeTruthy();
        expect(startGoogleDriveOAuth).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();
    });

    it("shows Adding, then Cancel, and moves from Discover to Installed like Slack", async () => {
        let resolveStart!: (value: { authorizationUrl: string }) => void;
        vi.mocked(startGoogleDriveOAuth).mockReturnValue(
            new Promise((resolve) => {
                resolveStart = resolve;
            }),
        );
        await clickAdd();
        expect(
            discover().getByRole("button", {
                name: "Add Google Drive connector",
            }),
        ).toHaveTextContent("Adding...");
        await act(async () => {
            resolveStart({
                authorizationUrl: `https://accounts.google.com/authorize?state=${state}`,
            });
            await flushMicrotasks();
        });
        expect(
            discover().getByRole("button", {
                name: "Cancel Google Drive authorization",
            }),
        ).toHaveTextContent("Cancel");

        vi.mocked(getGoogleDriveStatus).mockResolvedValue({
            ...ready,
            connected: true,
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
            await flushMicrotasks();
        });

        expect(cancelGoogleDriveOAuth).not.toHaveBeenCalled();
        expect(
            discover().queryByRole("button", {
                name: "Add Google Drive connector",
            }),
        ).toBeNull();
        expect(
            installed().getByRole("switch", { name: "Google Drive connector" }),
        ).toHaveAttribute("aria-checked", "true");
        expect(screen.queryByText("No connectors yet.")).toBeNull();

        // Manage opens the same dialog as Slack: tools and Delete.
        await act(async () => {
            fireEvent.click(
                installed().getByRole("button", {
                    name: "Manage Google Drive",
                }),
            );
            await flushMicrotasks();
        });
        const dialog = within(screen.getByRole("dialog"));
        expect(dialog.getByText("Search files")).toBeTruthy();
        expect(
            dialog.getByRole("switch", { name: "Ask for permission for write actions" }),
        ).toHaveAttribute("aria-checked", "false");
        vi.mocked(getGoogleDriveStatus).mockResolvedValue(ready);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Delete" }));
            await flushMicrotasks();
        });
        expect(disconnectGoogleDrive).toHaveBeenCalledOnce();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(
            discover().getByRole("button", {
                name: "Add Google Drive connector",
            }),
        ).toBeEnabled();
    });

    it("cancels the server-side attempt and stops polling, without an error", async () => {
        await clickAdd();
        await act(async () => {
            fireEvent.click(
                discover().getByRole("button", {
                    name: "Cancel Google Drive authorization",
                }),
            );
            await vi.advanceTimersByTimeAsync(0);
            await flushMicrotasks();
        });
        expect(cancelGoogleDriveOAuth).toHaveBeenCalledWith(state);
        expect(screen.queryByText("Could not add connector")).toBeNull();
        const count = vi.mocked(getGoogleDriveStatus).mock.calls.length;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10000);
        });
        expect(getGoogleDriveStatus).toHaveBeenCalledTimes(count);
        expect(
            discover().getByRole("button", {
                name: "Add Google Drive connector",
            }),
        ).toBeEnabled();
    });

    it("shows a completed connection if consent wins the cancellation race", async () => {
        await clickAdd();
        vi.mocked(getGoogleDriveStatus).mockResolvedValue({
            ...ready,
            connected: true,
        });
        await act(async () => {
            fireEvent.click(
                discover().getByRole("button", {
                    name: "Cancel Google Drive authorization",
                }),
            );
            await vi.advanceTimersByTimeAsync(0);
            await flushMicrotasks();
        });
        expect(
            installed().getByRole("button", { name: "Manage Google Drive" }),
        ).toBeTruthy();
    });

    it("hides unexpected connection errors", async () => {
        vi.mocked(startGoogleDriveOAuth).mockRejectedValue(
            new Error("internal-sentinel"),
        );
        await clickAdd();
        expect(screen.getByText("Could not add connector")).toBeTruthy();
        expect(screen.queryByText(/internal-sentinel/)).toBeNull();
    });

    it("reports a status outage honestly", async () => {
        vi.mocked(getGoogleDriveStatus).mockRejectedValue(
            new Error("internal-sentinel"),
        );
        await clickAdd();
        expect(
            screen.getByText(/Could not load Google Drive\. Reload this page/),
        ).toBeTruthy();
        expect(screen.queryByText(/internal-sentinel/)).toBeNull();
        expect(window.open).not.toHaveBeenCalled();
    });

    it("turns an installed Google connector off from its card", async () => {
        vi.mocked(getGoogleDriveStatus).mockResolvedValue({
            ...ready,
            connected: true,
        });
        vi.mocked(updateGoogleDriveSettings).mockResolvedValue({
            ...ready,
            connected: true,
            enabled: false,
        });
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        await act(async () => {
            fireEvent.click(
                installed().getByRole("switch", {
                    name: "Google Drive connector",
                }),
            );
            await flushMicrotasks();
        });
        expect(updateGoogleDriveSettings).toHaveBeenCalledWith({
            enabled: false,
        });
        expect(
            installed().getByRole("switch", { name: "Google Drive connector" }),
        ).toHaveAttribute("aria-checked", "false");
    });
});

describe("Connector write approval settings", () => {
    const gmailStatus: GoogleWorkspaceStatus = {
        configured: true,
        schemaReady: true,
        connected: true,
        writeEnabled: true,
        enabled: true,
        requireWriteApproval: false,
        accountEmail: "a.very.long.mailbox.name.for.testing@example-law-firm.com",
        grantId: "g1",
        redirectUri: null,
        tools: [
            {
                name: "gmail_search",
                title: "Search email",
                description: "Search email.",
                write: false,
                enabled: true,
            },
            {
                name: "gmail_send",
                title: "Send email",
                description: "Send a new plain-text email.",
                write: true,
                enabled: true,
            },
        ],
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.mocked(getGoogleWorkspaceStatus).mockImplementation(async (provider) =>
            provider === "gmail"
                ? gmailStatus
                : { ...gmailStatus, connected: false },
        );
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    async function openGmail() {
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        await act(async () => {
            fireEvent.click(
                within(screen.getByRole("region", { name: "Installed" })).getByRole(
                    "button",
                    { name: "Manage Gmail" },
                ),
            );
            await flushMicrotasks();
        });
        return within(screen.getByRole("dialog"));
    }

    it("sets Gmail's approval and tool switches from the shared Manage dialog", async () => {
        vi.mocked(updateGoogleWorkspaceSettings).mockResolvedValue({
            ...gmailStatus,
            requireWriteApproval: true,
        });
        vi.mocked(setGoogleWorkspaceToolEnabled).mockResolvedValue({
            ...gmailStatus,
            requireWriteApproval: true,
            tools: gmailStatus.tools.map((tool) => ({
                ...tool,
                enabled: tool.name !== "gmail_send",
            })),
        });
        const dialog = await openGmail();

        // The full account stays visible.
        expect(dialog.getByText("Account")).toBeTruthy();
        expect(dialog.getByText(gmailStatus.accountEmail!)).toBeTruthy();
        expect(dialog.getByText("Write")).toBeTruthy();
        const approval = dialog.getByRole("switch", {
            name: "Ask for permission for write actions",
        });
        expect(approval).toHaveAttribute("aria-checked", "false");
        await act(async () => {
            fireEvent.click(approval);
            await flushMicrotasks();
        });
        expect(updateGoogleWorkspaceSettings).toHaveBeenCalledWith("gmail", {
            requireWriteApproval: true,
        });
        expect(approval).toHaveAttribute("aria-checked", "true");

        await act(async () => {
            fireEvent.click(
                dialog.getByRole("switch", { name: "Send email enabled" }),
            );
            await flushMicrotasks();
        });
        expect(setGoogleWorkspaceToolEnabled).toHaveBeenCalledWith(
            "gmail",
            "gmail_send",
            false,
        );
    });

    it("sets an MCP connector's approval setting and lets write tools be switched", async () => {
        const slack = makeSummary({
            id: "slack-1",
            name: "Slack",
            serverUrl: "https://mcp.slack.com/mcp",
            oauthConnected: true,
            toolCount: 1,
            tools: [
                {
                    id: "tool-post",
                    toolName: "post_message",
                    openaiToolName: "mcp_slack_post_message",
                    title: "Post message",
                    description: "Post a message.",
                    enabled: true,
                    readOnly: false,
                    destructive: false,
                    write: true,
                    lastSeenAt: "2026-01-01T00:00:00Z",
                },
            ],
        });
        vi.mocked(listMcpConnectors).mockResolvedValue([slack]);
        vi.mocked(getMcpConnector).mockResolvedValue(slack);
        vi.mocked(updateMcpConnector).mockResolvedValue({
            ...slack,
            requireWriteApproval: true,
        });
        vi.mocked(setMcpToolEnabled).mockResolvedValue({
            ...slack,
            tools: [{ ...slack.tools[0], enabled: false }],
        });
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Manage Slack" }));
            await flushMicrotasks();
        });
        const dialog = within(screen.getByRole("dialog"));
        await act(async () => {
            fireEvent.click(
                dialog.getByRole("switch", {
                    name: "Ask for permission for write actions",
                }),
            );
            await flushMicrotasks();
        });
        expect(updateMcpConnector).toHaveBeenCalledWith("slack-1", {
            requireWriteApproval: true,
        });
        const tool = dialog.getByRole("switch", { name: "Post message enabled" });
        expect(tool).toBeEnabled();
        await act(async () => {
            fireEvent.click(tool);
            await flushMicrotasks();
        });
        expect(setMcpToolEnabled).toHaveBeenCalledWith(
            "slack-1",
            "tool-post",
            false,
        );
    });
});

describe("Connector read-only mode", () => {
    const tools = [
        { name: "search", title: "Search records", description: "Read records.", write: false, enabled: true },
        { name: "create", title: "Create record", description: "Write a record.", write: true, enabled: true },
        { name: "delete", title: "Delete record", description: "Delete a record.", write: true, enabled: false },
    ];
    const status = {
        configured: true, schemaReady: true, connected: true, enabled: true,
        writeEnabled: true, readOnly: false, requireWriteApproval: true,
        scope: null, redirectUri: null, tools,
    };
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.mocked(getGoogleDriveStatus).mockResolvedValue({ ...status, connected: false });
        vi.mocked(getGoogleWorkspaceStatus).mockResolvedValue({ ...status, connected: false });
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        ["Google Drive", "google-drive"],
        ["Gmail", "gmail"],
        ["Google Calendar", "google-calendar"],
        ["Slack", "mcp"],
    ] as const)("disables %s writes and restores individual choices", async (name, provider) => {
        const updated = (readOnly: boolean) => ({
            ...status, readOnly,
            tools: tools.map(tool => ({ ...tool, enabled: tool.enabled && !(readOnly && tool.write) })),
        });
        const mcp = makeSummary({ name: "Slack", serverUrl: "https://mcp.slack.com/mcp", readOnly: false, requireWriteApproval: true, tools: tools.map(tool => ({
            id: tool.name, toolName: tool.name, openaiToolName: tool.name,
            title: tool.title, description: tool.description, enabled: tool.enabled,
            readOnly: !tool.write, destructive: tool.write, write: tool.write, lastSeenAt: "2026-10-02T00:00:00Z",
        })), toolCount: tools.length });
        if (provider === "mcp") {
            vi.mocked(listMcpConnectors).mockResolvedValue([mcp]);
            vi.mocked(getMcpConnector).mockResolvedValue(mcp);
            vi.mocked(updateMcpConnector).mockImplementation(async (_id, settings) => ({
                ...mcp, readOnly: settings.readOnly,
                tools: mcp.tools.map(tool => ({ ...tool, enabled: tool.enabled && !(settings.readOnly && tool.write) })),
            }));
        } else if (provider === "google-drive") {
            vi.mocked(getGoogleDriveStatus).mockResolvedValue(status);
            vi.mocked(updateGoogleDriveSettings).mockImplementation(async settings => updated(settings.readOnly === true));
        } else {
            vi.mocked(getGoogleWorkspaceStatus).mockImplementation(async requested => ({ ...status, connected: requested === provider }));
            vi.mocked(updateGoogleWorkspaceSettings).mockImplementation(async (_provider, settings) => updated(settings.readOnly === true));
        }
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        await act(async () => {
            fireEvent.click(within(screen.getByRole("region", { name: "Installed" })).getByRole("button", { name: `Manage ${name}` }));
            await flushMicrotasks();
        });
        const dialog = within(screen.getByRole("dialog"));
        const toggle = dialog.getByRole("switch", { name: "Read-only" });
        const write = dialog.getByRole("switch", { name: "Create record enabled" });
        const read = dialog.getByRole("switch", { name: "Search records enabled" });
        const off = dialog.getByRole("switch", { name: "Delete record enabled" });
        expect(write).toHaveAttribute("aria-checked", "true");
        expect(dialog.getByRole("switch", { name: "Ask for permission for write actions" })).toHaveAttribute("aria-checked", "true");
        await act(async () => { fireEvent.click(toggle); await flushMicrotasks(); });
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(dialog.queryByRole("switch", { name: "Ask for permission for write actions" })).not.toBeInTheDocument();
        expect(dialog.queryByText("Ask for permission for write actions")).not.toBeInTheDocument();
        expect(write).toHaveAttribute("aria-checked", "false");
        expect(write).toBeDisabled();
        expect(off).toBeDisabled();
        expect(read).toBeEnabled();
        expect(read).toHaveAttribute("aria-checked", "true");
        if (provider === "mcp") expect(updateMcpConnector).toHaveBeenCalledWith(mcp.id, { readOnly: true });
        else if (provider === "google-drive") expect(updateGoogleDriveSettings).toHaveBeenCalledWith({ readOnly: true });
        else expect(updateGoogleWorkspaceSettings).toHaveBeenCalledWith(provider, { readOnly: true });
        await act(async () => { fireEvent.click(toggle); await flushMicrotasks(); });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(write).toBeEnabled();
        expect(dialog.getByRole("switch", { name: "Ask for permission for write actions" })).toHaveAttribute("aria-checked", "true");
        expect(write).toHaveAttribute("aria-checked", "true");
        expect(off).toHaveAttribute("aria-checked", "false");
    });

    it("prevents overlapping tool and connector changes while the mode is saving", async () => {
        let finishSave!: (value: typeof status) => void;
        vi.mocked(getGoogleDriveStatus).mockResolvedValue(status);
        vi.mocked(updateGoogleDriveSettings).mockImplementation(() => new Promise(resolve => { finishSave = resolve; }));
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Manage Google Drive" }));
            await flushMicrotasks();
        });
        const dialog = within(screen.getByRole("dialog"));
        const toggle = dialog.getByRole("switch", { name: "Read-only" });
        await act(async () => { fireEvent.click(toggle); await flushMicrotasks(); });
        expect(toggle).toBeDisabled();
        expect(toggle).toHaveAttribute("aria-busy", "true");
        expect(dialog.getByRole("switch", { name: "Create record enabled" })).toBeDisabled();
        expect(dialog.getByRole("switch", { name: "Ask for permission for write actions" })).toBeDisabled();
        expect(dialog.getByRole("button", { name: "Refresh" })).toBeDisabled();
        expect(dialog.getByRole("button", { name: "Delete" })).toBeDisabled();
        await act(async () => { finishSave({ ...status, readOnly: true }); await flushMicrotasks(); });
        expect(toggle).toBeEnabled();
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(dialog.queryByRole("switch", { name: "Ask for permission for write actions" })).not.toBeInTheDocument();
        expect(dialog.queryByText("Ask for permission for write actions")).not.toBeInTheDocument();
        expect(dialog.getByRole("switch", { name: "Create record enabled" })).toBeDisabled();
    });

    it("shows a failed save and leaves write tools unchanged", async () => {
        vi.mocked(getGoogleDriveStatus).mockResolvedValue(status);
        vi.mocked(updateGoogleDriveSettings).mockRejectedValue(new Error("private backend detail"));
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Manage Google Drive" }));
            await flushMicrotasks();
        });
        const dialog = within(screen.getByRole("dialog"));
        const toggle = dialog.getByRole("switch", { name: "Read-only" });
        await act(async () => { fireEvent.click(toggle); await flushMicrotasks(); });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(dialog.getByRole("switch", { name: "Create record enabled" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByText("Connector update failed")).toBeVisible();
        expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
    });

    it("shows a failed MCP save in the dialog", async () => {
        const mcp = makeSummary({ name: "Slack", serverUrl: "https://mcp.slack.com/mcp", readOnly: false });
        vi.mocked(listMcpConnectors).mockResolvedValue([mcp]);
        vi.mocked(getMcpConnector).mockResolvedValue(mcp);
        vi.mocked(updateMcpConnector).mockRejectedValue(new Error("private backend detail"));
        render(<ConnectorsPage />);
        await act(flushMicrotasks);
        await act(async () => {
            fireEvent.click(within(screen.getByRole("region", { name: "Installed" })).getByRole("button", { name: "Manage Slack" }));
            await flushMicrotasks();
        });
        const toggle = within(screen.getByRole("dialog")).getByRole("switch", { name: "Read-only" });
        await act(async () => { fireEvent.click(toggle); await flushMicrotasks(); });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        expect(screen.getByText("Connector update failed")).toBeVisible();
        expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
    });
});
