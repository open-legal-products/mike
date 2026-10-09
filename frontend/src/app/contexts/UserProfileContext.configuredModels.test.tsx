import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MIKE-FRONTEND-B/C/D/E: every burst of browser "Failed to fetch" reports
// carried /api/models/configured twice. This pins the request count of one
// signed-in page mount, with the real API client and a network that never
// answers, so the double fetch cannot come back.

const reportNetworkFailure = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/errorReporting", () => ({
    isReported: () => false,
    reportError: vi.fn(),
    trackPendingRequest: () => () => {},
    reportApiFailure: vi.fn(),
    reportNetworkFailure,
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" }, isAuthenticated: true }),
}));

import { UserProfileProvider } from "./UserProfileContext";
import {
    CONFIGURED_MODELS_MAX_AGE_MS,
    clearConfiguredModels,
    useConfiguredModels,
} from "@/app/hooks/useConfiguredModels";

// ChatInput and its ModelToggle both read the configured catalog, and both
// mount in the same commit as the provider once the session resolves.
function ModelConsumer() {
    useConfiguredModels();
    return null;
}

const fetchMock = vi.fn();

function requestsTo(path: string) {
    return fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith(`/api${path}`),
    ).length;
}

describe("configured model catalog on a signed-in page mount", () => {
    beforeEach(() => {
        clearConfiguredModels();
        fetchMock.mockReset();
        reportNetworkFailure.mockReset();
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("requests /models/configured once, not once per owner of the cache", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        render(
            <UserProfileProvider>
                <ModelConsumer />
                <ModelConsumer />
            </UserProfileProvider>,
        );

        await waitFor(() =>
            expect(requestsTo("/models/configured")).toBeGreaterThan(0),
        );
        // Let every mount-time request settle before counting.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(requestsTo("/models/configured")).toBe(1);
        expect(
            reportNetworkFailure.mock.calls.filter(([, request]) =>
                (request as { url: string }).url.startsWith(
                    "/api/models/configured",
                ),
            ),
        ).toHaveLength(1);
    });

    // The assistant page chunk (ChatInput, ModelToggle) mounts after the
    // shell, when the provider's request has already resolved. A picker that
    // mounts then must reuse the loaded catalog, not revalidate it: the
    // provider already refreshes it on sign-in, user change and key save.
    it("does not request /models/configured again for a picker that mounts later", async () => {
        fetchMock.mockImplementation(async () =>
            new Response(JSON.stringify({ models: [] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );

        const view = render(<UserProfileProvider>{null}</UserProfileProvider>);
        await waitFor(() => expect(requestsTo("/models/configured")).toBe(1));
        // Let the provider's request resolve and populate the shared cache.
        await new Promise((resolve) => setTimeout(resolve, 20));

        view.rerender(
            <UserProfileProvider>
                <ModelConsumer />
                <ModelConsumer />
            </UserProfileProvider>,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(requestsTo("/models/configured")).toBe(1);
    });

    // A key saved in another tab never reaches this tab's provider, so a
    // catalog older than the freshness window is revalidated by the next
    // picker to mount: once, with later pickers joining that request.
    it("revalidates a catalog older than the freshness window, once", async () => {
        fetchMock.mockImplementation(async () =>
            new Response(JSON.stringify({ models: [] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            const view = render(<UserProfileProvider>{null}</UserProfileProvider>);
            await waitFor(() => expect(requestsTo("/models/configured")).toBe(1));
            await new Promise((resolve) => setTimeout(resolve, 20));

            vi.setSystemTime(Date.now() + CONFIGURED_MODELS_MAX_AGE_MS + 1);
            view.rerender(
                <UserProfileProvider>
                    <ModelConsumer />
                    <ModelConsumer />
                </UserProfileProvider>,
            );
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(requestsTo("/models/configured")).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
