import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetupPage from "./page";
import { AuthApiError } from "@/app/lib/authApi";

const { setupFirstAccount, refreshSession, replace, push, signInOptions } = vi.hoisted(() => ({
    setupFirstAccount: vi.fn(),
    refreshSession: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
    signInOptions: {
        current: {
            options: { google: false, sso: false, setupRequired: true, signup: true },
            loaded: true,
        },
    },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
}));

vi.mock("@/app/lib/authApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/authApi")>()),
    setupFirstAccount,
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ isAuthenticated: false, authLoading: false, refreshSession }),
}));

vi.mock("@/app/hooks/useSignInOptions", () => ({
    useSignInOptions: () => signInOptions.current,
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

async function fillForm(password = "correct-horse-battery", confirm = password) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.type(screen.getByLabelText("Password"), password);
    await user.type(screen.getByLabelText("Confirm Password"), confirm);
    await user.click(screen.getByRole("button", { name: "Create account" }));
}

describe("SetupPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        signInOptions.current = {
            options: { google: false, sso: false, setupRequired: true, signup: true },
            loaded: true,
        };
        setupFirstAccount.mockResolvedValue({ user: { id: "u1" } });
        refreshSession.mockResolvedValue(undefined);
    });

    it("creates the first account, signs it in and continues to onboarding", async () => {
        render(<SetupPage />);
        expect(screen.getByRole("heading", { name: "Set up Mike" })).toBeInTheDocument();
        await fillForm();
        expect(setupFirstAccount).toHaveBeenCalledWith("owner@example.com", "correct-horse-battery");
        expect(refreshSession).toHaveBeenCalled();
        expect(push).toHaveBeenCalledWith("/onboarding/profile");
    });

    it("checks the passwords before calling the API", async () => {
        render(<SetupPage />);
        await fillForm("correct-horse-battery", "something-else-entirely");
        expect(setupFirstAccount).not.toHaveBeenCalled();
        expect(await screen.findByText("The two passwords don't match.")).toBeInTheDocument();
    });

    it("explains when someone else finished setup first and offers log in", async () => {
        setupFirstAccount.mockRejectedValue(
            new AuthApiError(409, "setup_complete", "This Mike instance is already set up. Log in instead."),
        );
        render(<SetupPage />);
        await fillForm();
        expect(
            await screen.findByText("This Mike instance is already set up. Log in instead."),
        ).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
        expect(push).not.toHaveBeenCalled();
    });

    it("sends visitors to log in once the instance is set up", () => {
        signInOptions.current = {
            options: { google: false, sso: false, setupRequired: false, signup: true },
            loaded: true,
        };
        render(<SetupPage />);
        expect(replace).toHaveBeenCalledWith("/login");
        expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
    });
});
