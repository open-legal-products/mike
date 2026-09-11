import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SsoLoginPage from "./page";

const { startSso, replace } = vi.hoisted(() => ({
    startSso: vi.fn(),
    replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace }),
}));

vi.mock("@/app/lib/authApi", () => ({ startSso }));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ isAuthenticated: false, authLoading: false }),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("SsoLoginPage", () => {
    beforeEach(() => {
        startSso.mockReset();
        replace.mockReset();
        startSso.mockResolvedValue({ url: "https://idp.example/saml" });
    });

    it("starts SSO with the company email", async () => {
        const user = userEvent.setup();
        render(<SsoLoginPage />);

        const button = screen.getByRole("button", { name: "Continue" });
        expect(button).toBeDisabled();
        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            " Lawyer@Example.com ",
        );
        await user.click(button);

        expect(startSso).toHaveBeenCalledWith(
            "/onboarding/profile",
            "Lawyer@Example.com",
        );
        expect(
            screen.getByRole("button", { name: "Continuing…" }),
        ).toBeDisabled();
    });

    it("shows an intentional error and allows retry", async () => {
        startSso.mockRejectedValue({ code: "sso_domain_not_allowed" });
        const user = userEvent.setup();
        render(<SsoLoginPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "lawyer@other.example",
        );
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Single sign-on is not available for this email domain.",
        );
        expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    });
});
