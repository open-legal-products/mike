import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

const { login, signup, startGoogleOAuth, refreshSession, replace, push } =
    vi.hoisted(() => ({
        login: vi.fn(),
        signup: vi.fn(),
        startGoogleOAuth: vi.fn(),
        refreshSession: vi.fn(),
        replace: vi.fn(),
        push: vi.fn(),
    }));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
}));

vi.mock("@/app/lib/authApi", () => ({
    login,
    signup,
    startGoogleOAuth,
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        isAuthenticated: false,
        authLoading: false,
        refreshSession,
    }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("LoginPage", () => {
    beforeEach(() => {
        login.mockReset();
        signup.mockReset();
        startGoogleOAuth.mockReset();
        delete (window as { mikeDesktop?: unknown }).mikeDesktop;
        refreshSession.mockReset();
        refreshSession.mockResolvedValue(null);
        replace.mockReset();
        push.mockReset();
    });

    it("allows an existing account to submit a password shorter than the new minimum", async () => {
        login.mockResolvedValue({ user: { id: "user-1" } });
        const user = userEvent.setup();
        render(<LoginPage />);

        expect(screen.getByLabelText("Password")).not.toHaveAttribute(
            "placeholder",
        );

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "existing@example.com",
        );
        await user.type(screen.getByLabelText("Password"), "oldpass");
        await user.click(screen.getByRole("button", { name: "Log in" }));

        expect(login).toHaveBeenCalledWith("existing@example.com", "oldpass");
        expect(push).toHaveBeenCalledWith("/onboarding/profile");
    });

    it("places Google and SSO after the primary login action", () => {
        render(<LoginPage />);

        const login = screen.getByRole("button", { name: "Log in" });
        const google = screen.getByRole("button", {
            name: "Continue with Google",
        });
        const sso = screen.getByRole("button", { name: "Continue with SSO" });
        expect(
            login.compareDocumentPosition(google) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            google.compareDocumentPosition(sso) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });
    it("hides the guest button outside the Mac desktop shell", async () => {
        // window.mikeDesktop only exists inside the Electron shell, and only
        // its local ("everything on this Mac") mode answers with credentials.
        // In a browser and against Mike Cloud this page must be unchanged.
        render(<LoginPage />);
        expect(
            screen.queryByRole("button", { name: "Continue as guest" }),
        ).toBeNull();
    });

    it("signs a returning guest in with the shell's credentials", async () => {
        (window as unknown as Record<string, unknown>).mikeDesktop = {
            guestCredentials: () =>
                Promise.resolve({
                    email: "guest@mike.local",
                    password: "per-install-secret",
                }),
        };
        login.mockResolvedValue({ user: { id: "guest-1" } });
        const user = userEvent.setup();
        render(<LoginPage />);

        const button = await screen.findByRole("button", {
            name: "Continue as guest",
        });
        await user.click(button);

        expect(login).toHaveBeenCalledWith(
            "guest@mike.local",
            "per-install-secret",
        );
        expect(signup).not.toHaveBeenCalled();
        // The session lives in an httpOnly cookie, so the context must re-read
        // it before the router leaves for a gated route.
        expect(refreshSession).toHaveBeenCalled();
        expect(push).toHaveBeenCalledWith("/onboarding/profile");
    });

    it("falls back to signup the first time a guest ever clicks", async () => {
        (window as unknown as Record<string, unknown>).mikeDesktop = {
            guestCredentials: () =>
                Promise.resolve({
                    email: "guest@mike.local",
                    password: "per-install-secret",
                }),
        };
        // No such account yet: /auth/login 401s, and the local stack
        // autoconfirms the signup that follows.
        login.mockRejectedValue(new Error("invalid_credentials"));
        signup.mockResolvedValue({
            user: { id: "guest-1" },
            requiresEmailConfirmation: false,
        });
        const user = userEvent.setup();
        render(<LoginPage />);

        await user.click(
            await screen.findByRole("button", { name: "Continue as guest" }),
        );

        expect(signup).toHaveBeenCalledWith(
            "guest@mike.local",
            "per-install-secret",
            "/onboarding/profile",
        );
        expect(push).toHaveBeenCalledWith("/onboarding/profile");
    });
});
