import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import { AUTH_SESSION_INVALIDATED_EVENT } from "@/app/lib/authEvents";
import {
    ToastViewportUI,
    clearToasts,
    showToast,
} from "@/shared/ui/ToastUI";

const {
    clearLegacyBrowserAuthStorage,
    getAuthSession,
    logout,
    updateAuthEmail,
    updateAuthPassword,
} = vi.hoisted(() => ({
    clearLegacyBrowserAuthStorage: vi.fn(),
    getAuthSession: vi.fn(),
    logout: vi.fn(),
    updateAuthEmail: vi.fn(),
    updateAuthPassword: vi.fn(),
}));

vi.mock("@/app/lib/authApi", () => ({
    clearLegacyBrowserAuthStorage,
    getAuthSession,
    logout,
    updateAuthEmail,
    updateAuthPassword,
}));

const user = {
    id: "user-1",
    email: "lawyer@example.test",
    pendingEmail: null,
    createdWithGoogle: false,
};

function Consumer() {
    const { user: currentUser, authLoading, authError, signOut } = useAuth();
    return (
        <>
            <span data-testid="user">{currentUser?.email ?? "signed-out"}</span>
            <span data-testid="loading">{String(authLoading)}</span>
            <span data-testid="error">{authError ?? ""}</span>
            <button
                type="button"
                onClick={() => void signOut().catch(() => {})}
            >
                Sign out
            </button>
        </>
    );
}

describe("AuthProvider", () => {
    beforeEach(() => {
        getAuthSession.mockReset();
        logout.mockReset();
        clearLegacyBrowserAuthStorage.mockReset();
        updateAuthEmail.mockReset();
        updateAuthPassword.mockReset();
        window.localStorage.clear();
    });

    it("surfaces an initial session failure without leaving loading stuck", async () => {
        getAuthSession.mockRejectedValue(new Error("gateway unavailable"));

        render(
            <AuthProvider>
                <Consumer />
            </AuthProvider>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("loading")).toHaveTextContent("false"),
        );
        expect(screen.getByTestId("user")).toHaveTextContent("signed-out");
        expect(screen.getByTestId("error")).toHaveTextContent(
            "We could not check your session",
        );
    });

    it("clears stale in-memory auth when an API request returns 401", async () => {
        getAuthSession.mockResolvedValue(user);
        render(
            <AuthProvider>
                <Consumer />
            </AuthProvider>,
        );
        await screen.findByText(user.email);

        fireEvent(window, new Event(AUTH_SESSION_INVALIDATED_EVENT));

        expect(screen.getByTestId("user")).toHaveTextContent("signed-out");
        expect(screen.getByTestId("error")).toHaveTextContent(
            "Your session expired",
        );
    });

    it("keeps the user signed in and exposes an error when logout fails", async () => {
        getAuthSession.mockResolvedValue(user);
        logout.mockRejectedValue(new Error("network failure"));
        render(
            <AuthProvider>
                <Consumer />
            </AuthProvider>,
        );
        await screen.findByText(user.email);

        fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

        await waitFor(() =>
            expect(screen.getByTestId("error")).toHaveTextContent(
                "Unable to sign out",
            ),
        );
        expect(screen.getByTestId("user")).toHaveTextContent(user.email);
    });

    it("applies a sign-out broadcast from another tab", async () => {
        getAuthSession.mockResolvedValue(user);
        render(
            <AuthProvider>
                <Consumer />
            </AuthProvider>,
        );
        await screen.findByText(user.email);

        const event = new Event("storage") as StorageEvent;
        Object.defineProperties(event, {
            key: { value: "mike-auth-state-change" },
            newValue: {
                value: JSON.stringify({
                    state: "signed-out",
                    nonce: "another-tab",
                }),
            },
        });
        window.dispatchEvent(event);

        await waitFor(() =>
            expect(screen.getByTestId("user")).toHaveTextContent("signed-out"),
        );
    });

    it("clears leftover toasts when the user signs out", async () => {
        getAuthSession.mockResolvedValue(user);
        logout.mockResolvedValue(undefined);

        render(
            <AuthProvider>
                <Consumer />
                <ToastViewportUI />
            </AuthProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("user")).toHaveTextContent(user.email),
        );

        // A failure raised while signed in, still on screen: its "Retry"
        // would now run as nobody, over the login form.
        showToast({
            tone: "error",
            title: "Couldn't save the document",
            message: "Try again.",
            actions: [{ label: "Retry", onClick: () => {} }],
        });
        expect(await screen.findByRole("alert")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

        await waitFor(() =>
            expect(screen.getByTestId("user")).toHaveTextContent("signed-out"),
        );
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
        clearToasts();
    });
});
