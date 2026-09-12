import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SsoLoginPage from "./page";
import { withIntl } from "@/test/withIntl";

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
        render(withIntl(<SsoLoginPage />));

        const button = screen.getByRole("button", { name: "Continuar" });
        expect(button).toBeDisabled();
        await user.type(
            screen.getByRole("textbox", { name: "E-mail" }),
            " Lawyer@Example.com ",
        );
        await user.click(button);

        expect(startSso).toHaveBeenCalledWith(
            "/onboarding/profile",
            "Lawyer@Example.com",
        );
        expect(
            screen.getByRole("button", { name: "Continuando..." }),
        ).toBeDisabled();
    });

    it("shows an intentional error and allows retry", async () => {
        startSso.mockRejectedValue({ code: "sso_domain_not_allowed" });
        const user = userEvent.setup();
        render(withIntl(<SsoLoginPage />));

        await user.type(
            screen.getByRole("textbox", { name: "E-mail" }),
            "lawyer@other.example",
        );
        await user.click(screen.getByRole("button", { name: "Continuar" }));

        expect(screen.getByRole("alert")).toHaveTextContent(
            "O login único não está disponível para este domínio de e-mail.",
        );
        expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    });
});
