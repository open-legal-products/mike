import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectorsPage from "./page";
import {
    MikeApiError,
    type McpConnectorSummary,
    createMcpConnector,
    getMcpConnector,
    listMcpConnectors,
    provisionPatentMcpConnector,
    refreshMcpConnectorTools,
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
        provisionPatentMcpConnector: vi.fn(),
        refreshMcpConnectorTools: vi.fn(),
        startMcpConnectorOAuth: vi.fn(),
        getMcpConnector: vi.fn(),
        updateMcpConnector: vi.fn(),
    };
});

// The page reads the USPTO feature switch from the profile context.
const profileState = vi.hoisted(() => ({
    usptoEnabled: false,
    degraded: false,
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { usptoConnectorEnabled: profileState.usptoEnabled },
        apiKeysDegraded: profileState.degraded,
        reloadProfile: vi.fn(),
    }),
}));

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
        managed: false,
        serverUrl: "https://drivemcp.googleapis.com/mcp",
        authType: "oauth",
        enabled: true,
        hasAuthConfig: false,
        customHeaderKeys: [],
        oauthConnected: false,
        toolPolicy: {},
        managedCredentials: {
            usptoApiKey: false,
            tsdrApiKey: false,
            tmsearchWafToken: false,
        },
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

    fireEvent.click(screen.getByRole("button", { name: /add/i }));
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
        vi.mocked(createMcpConnector).mockResolvedValue(makeSummary());
        // Forces the OAuth popup branch of handleCreate.
        vi.mocked(refreshMcpConnectorTools).mockRejectedValue(
            new MikeApiError({
                message: "oauth required",
                status: 409,
                code: "oauth_required",
            }),
        );
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
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Details" }));
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

    it("prefills the form when the Slack preset is clicked", async () => {
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        fireEvent.click(screen.getByRole("button", { name: /add/i }));
        fireEvent.click(
            screen.getByRole("button", { name: /slack mcp\.slack\.com/i }),
        );

        expect(
            (screen.getByPlaceholderText("Connector label") as HTMLInputElement)
                .value,
        ).toBe("Slack");
        expect(
            (
                screen.getByPlaceholderText(
                    "https://mcp.example.com/mcp",
                ) as HTMLInputElement
            ).value,
        ).toBe("https://mcp.slack.com/mcp");
    });
});

describe("ConnectorsPage operator setup guidance", () => {
    const popupClose = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
        vi.spyOn(window, "open").mockReturnValue({
            location: { href: "" },
            close: popupClose,
            closed: false,
        } as unknown as Window);
    });

    afterEach(() => {
        cleanup();
    });

    it("hands a just-created connector that needs deployment setup to its details modal, with the instructions", async () => {
        // Slack has no dynamic client registration: the connector row is
        // created, the tool refresh says "oauth required", and the OAuth
        // start is refused with connector_setup_required carrying the
        // operator steps and this deployment's redirect URI. The Add modal
        // must NOT stay open on its form (a second Connect would create a
        // duplicate); the new connector's details open instead.
        vi.mocked(createMcpConnector).mockResolvedValue(makeSummary());
        vi.mocked(getMcpConnector).mockResolvedValue(makeSummary());
        vi.mocked(refreshMcpConnectorTools).mockRejectedValue(
            new MikeApiError({
                message: "oauth required",
                status: 409,
                code: "oauth_required",
            }),
        );
        const instructions =
            "Slack's MCP server needs a pre-configured OAuth client — add http://localhost:3000/api/user/mcp-connectors/oauth/callback as a redirect URL and set SLACK_MCP_OAUTH_CLIENT_ID.";
        vi.mocked(startMcpConnectorOAuth).mockRejectedValue(
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
        fireEvent.click(screen.getByRole("button", { name: /add/i }));
        fireEvent.click(
            screen.getByRole("button", { name: /slack mcp\.slack\.com/i }),
        );
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Connect" }));
            await flushMicrotasks();
        });

        const notice = screen.getByRole("status");
        expect(notice.textContent).toContain(
            "This server needs a one-time setup by the administrator",
        );
        expect(notice.textContent).toContain("SLACK_MCP_OAUTH_CLIENT_ID");
        expect(notice.textContent).toContain(
            "http://localhost:3000/api/user/mcp-connectors/oauth/callback",
        );
        // The Add modal is gone (no "New MCP connector" breadcrumb, no red
        // "Failed to add connector" line); the details modal is open.
        expect(screen.queryByText(/failed to add connector/i)).toBeNull();
        expect(screen.queryByText("New MCP connector")).toBeNull();
        expect(screen.getByRole("button", { name: /delete connector/i })).toBeTruthy();
        // The about:blank window opened ahead of the start call must not be
        // left behind: nothing will ever navigate it on this path.
        expect(window.open).toHaveBeenCalledTimes(1);
        expect(popupClose).toHaveBeenCalledTimes(1);
    });
});

describe("ConnectorsPage USPTO preset", () => {
    const managedSummary = (
        overrides: Partial<McpConnectorSummary> = {},
    ): McpConnectorSummary =>
        makeSummary({
            id: "patent-1",
            name: "USPTO Patent & Trademark",
            transport: "stdio",
            managed: true,
            serverUrl: "builtin://patent-mcp-server",
            authType: "none",
            ...overrides,
        });

    beforeEach(() => {
        vi.clearAllMocks();
        profileState.usptoEnabled = false;
        profileState.degraded = false;
        vi.mocked(needsMfaVerification).mockResolvedValue(false);
        vi.mocked(listMcpConnectors).mockResolvedValue([]);
    });

    afterEach(() => {
        cleanup();
    });

    it("hides the USPTO button unless the feature is enabled", async () => {
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
        expect(
            screen.queryByRole("button", { name: "USPTO" }),
        ).toBeNull();

        cleanup();
        profileState.usptoEnabled = true;
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });
        expect(screen.getByRole("button", { name: "USPTO" })).toBeTruthy();
    });

    it("provisions the managed connector and shows it", async () => {
        profileState.usptoEnabled = true;
        vi.mocked(provisionPatentMcpConnector).mockResolvedValue(
            managedSummary(),
        );
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "USPTO" }));
            await flushMicrotasks();
        });

        expect(provisionPatentMcpConnector).toHaveBeenCalledTimes(1);
        // The connector row appears…
        expect(screen.getByText("Managed stdio · patent-mcp-server 1.0.0")).toBeTruthy();
        // …and its details modal opens on the managed view.
        expect(
            screen.getByText(
                "Managed local connector. Mike runs it and controls its endpoint.",
            ),
        ).toBeTruthy();
    });

    it("shows a managed connector without the Delete button or endpoint form", async () => {
        const connector = managedSummary();
        vi.mocked(listMcpConnectors).mockResolvedValue([connector]);
        vi.mocked(getMcpConnector).mockResolvedValue(connector);
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Details" }));
            await flushMicrotasks();
        });

        expect(
            screen.queryByRole("button", { name: /delete connector/i }),
        ).toBeNull();
        expect(screen.queryByLabelText("URL endpoint")).toBeNull();
        expect(screen.queryByLabelText("Bearer token")).toBeNull();
        expect(
            screen.getByText(
                "Managed local connector. Mike runs it and controls its endpoint.",
            ),
        ).toBeTruthy();
        // Tool list controls remain available.
        expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
    });

    it("hides the USPTO button when a managed connector already exists", async () => {
        profileState.usptoEnabled = true;
        vi.mocked(listMcpConnectors).mockResolvedValue([managedSummary()]);
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        expect(screen.queryByRole("button", { name: "USPTO" })).toBeNull();
    });

    it("shows the three managed credential inputs with placeholders", async () => {
        const connector = managedSummary();
        vi.mocked(listMcpConnectors).mockResolvedValue([connector]);
        vi.mocked(getMcpConnector).mockResolvedValue(connector);
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Details" }));
            await flushMicrotasks();
        });

        expect(screen.getByPlaceholderText("USPTO_API_KEY")).toBeTruthy();
        expect(screen.getByPlaceholderText("TSDR_API_KEY")).toBeTruthy();
        expect(screen.getByPlaceholderText("TMSEARCH_WAF_TOKEN")).toBeTruthy();
    });

    it("renders Saved next to a stored managed credential", async () => {
        const connector = managedSummary({
            managedCredentials: {
                usptoApiKey: true,
                tsdrApiKey: false,
                tmsearchWafToken: false,
            },
        });
        vi.mocked(listMcpConnectors).mockResolvedValue([connector]);
        vi.mocked(getMcpConnector).mockResolvedValue(connector);
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Details" }));
            await flushMicrotasks();
        });

        const saved = screen.getAllByText("Saved");
        expect(saved).toHaveLength(1);
    });

    it("saves a credential and preserves an untouched saved one", async () => {
        const connector = managedSummary({
            managedCredentials: {
                usptoApiKey: true,
                tsdrApiKey: false,
                tmsearchWafToken: false,
            },
        });
        vi.mocked(listMcpConnectors).mockResolvedValue([connector]);
        vi.mocked(getMcpConnector).mockResolvedValue(connector);
        vi.mocked(updateMcpConnector).mockResolvedValue(
            managedSummary({
                managedCredentials: {
                    usptoApiKey: true,
                    tsdrApiKey: true,
                    tmsearchWafToken: false,
                },
            }),
        );
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Details" }));
            await flushMicrotasks();
        });

        fireEvent.change(screen.getByPlaceholderText("TSDR_API_KEY"), {
            target: { value: "  tsdr-secret  " },
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
            await flushMicrotasks();
        });

        // The untouched saved usptoApiKey is omitted, not cleared.
        expect(vi.mocked(updateMcpConnector)).toHaveBeenCalledWith("patent-1", {
            usptoCredentials: {
                tsdrApiKey: "tsdr-secret",
            },
        });
    });

    it("clears a saved credential only after an explicit Clear", async () => {
        const connector = managedSummary({
            managedCredentials: {
                usptoApiKey: true,
                tsdrApiKey: false,
                tmsearchWafToken: false,
            },
        });
        vi.mocked(listMcpConnectors).mockResolvedValue([connector]);
        vi.mocked(getMcpConnector).mockResolvedValue(connector);
        vi.mocked(updateMcpConnector).mockResolvedValue(
            managedSummary({
                managedCredentials: {
                    usptoApiKey: false,
                    tsdrApiKey: false,
                    tmsearchWafToken: false,
                },
            }),
        );
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Details" }));
            await flushMicrotasks();
        });

        const clearButtons = screen.getAllByRole("button", { name: "Clear" });
        expect(clearButtons).toHaveLength(1);
        fireEvent.click(clearButtons[0]);
        expect(screen.getByText("Cleared")).toBeTruthy();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
            await flushMicrotasks();
        });

        expect(vi.mocked(updateMcpConnector)).toHaveBeenCalledWith("patent-1", {
            usptoCredentials: {
                usptoApiKey: null,
            },
        });
    });

    it("hides setup and shows a retry when the profile is degraded", async () => {
        profileState.usptoEnabled = true;
        profileState.degraded = true;
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        expect(screen.queryByRole("button", { name: "USPTO" })).toBeNull();
        expect(screen.getByText(/Could not load settings/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("maps feature_disabled to the Settings > Features message", async () => {
        profileState.usptoEnabled = true;
        vi.mocked(provisionPatentMcpConnector).mockRejectedValue(
            new MikeApiError({
                message: "feature disabled",
                status: 403,
                code: "feature_disabled",
            }),
        );
        render(<ConnectorsPage />);
        await act(async () => {
            await flushMicrotasks();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "USPTO" }));
            await flushMicrotasks();
        });

        expect(
            screen.getByText(
                "Turn on USPTO Patent & Trademark in Settings > Features first.",
            ),
        ).toBeTruthy();
    });
});
