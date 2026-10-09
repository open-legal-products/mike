import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SignupPage from "./page";

const { signup, startGoogleOAuth, refreshSession, replace, push } = vi.hoisted(() => ({
    signup: vi.fn(),
    startGoogleOAuth: vi.fn(),
    refreshSession: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace, push }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/lib/authApi", () => ({
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

describe("SignupPage", () => {
    beforeEach(() => {
        signup.mockReset();
        startGoogleOAuth.mockReset();
        refreshSession.mockReset();
        replace.mockReset();
        push.mockReset();
    });

    it("creates credentials and waits for email confirmation", async () => {
        signup.mockResolvedValue({
            user: { id: "user-1" },
            requiresEmailConfirmation: true,
        });
        const user = userEvent.setup();
        render(<SignupPage />);

        expect(screen.getByLabelText("Password")).toHaveAttribute(
            "placeholder",
            "Min. 10 Characters",
        );

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "alex@example.com",
        );
        await user.type(screen.getByLabelText("Password"), "secret1234");
        await user.type(
            screen.getByLabelText("Confirm Password"),
            "secret1234",
        );
        await user.click(screen.getByRole("button", { name: "Sign up" }));

        expect(signup).toHaveBeenCalledWith(
            "alex@example.com",
            "secret1234",
            "/onboarding/profile",
        );
        expect(push).toHaveBeenCalledWith("/signup/check-email");
    });

    async function fillAndSubmit(password = "secret1234") {
        const user = userEvent.setup();
        render(<SignupPage />);
        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "alex@example.com",
        );
        await user.type(screen.getByLabelText("Password"), password);
        await user.type(screen.getByLabelText("Confirm Password"), password);
        await user.click(screen.getByRole("button", { name: "Sign up" }));
        return user;
    }

    it.each([
        [
            "an address that is already registered",
            Object.assign(new Error("User already registered"), {
                status: 422,
                code: "user_already_exists",
            }),
            "An account with this email already exists. Log in instead.",
        ],
        [
            "too many attempts",
            Object.assign(new Error("Request rate limit reached"), {
                status: 429,
            }),
            "Too many attempts. Wait a moment and try again.",
        ],
        [
            "a dropped connection",
            new TypeError("Failed to fetch"),
            "Mike couldn't reach the server. Check your connection and try again.",
        ],
        [
            "a password the server calls weak",
            Object.assign(new Error("Password is too weak"), {
                status: 422,
                code: "weak_password",
            }),
            "Choose a stronger password: at least 10 characters, mixing letters, numbers, and symbols.",
        ],
    ])("explains %s", async (_label, thrown, shown) => {
        signup.mockRejectedValue(thrown);

        await fillAndSubmit();

        expect(await screen.findByRole("alert")).toHaveTextContent(shown);
    });

    it("rejects a password longer than bcrypt accepts before calling the API", async () => {
        await fillAndSubmit("x".repeat(73));

        expect(signup).not.toHaveBeenCalled();
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Password must be at most 72 UTF-8 bytes. Accented characters and emoji can use more than one byte.",
        );
    });

    it("places Google after the primary signup action without offering SSO", () => {
        render(<SignupPage />);

        const signup = screen.getByRole("button", { name: "Sign up" });
        const google = screen.getByRole("button", {
            name: "Continue with Google",
        });
        expect(
            signup.compareDocumentPosition(google) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Continue with SSO" }),
        ).not.toBeInTheDocument();
    });
});
