import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectorsPage from "./page";
import {
    MikeApiError,
    type McpConnectorSummary,
    createMcpConnector,
    getMcpConnector,
    listMcpConnectors,
    refreshMcpConnectorTools,
    startMcpConnectorOAuth,
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
        refreshMcpConnectorTools: vi.fn(),
        startMcpConnectorOAuth: vi.fn(),
        getMcpConnector: vi.fn(),
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
                status: 401,
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
});
