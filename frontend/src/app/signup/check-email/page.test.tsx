import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import SignupCheckEmailPage from "./page";

const { replace, useAuth } = vi.hoisted(() => ({
    replace: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({ useAuth }));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("SignupCheckEmailPage", () => {
    beforeEach(() => {
        replace.mockReset();
        useAuth.mockReturnValue({
            isAuthenticated: false,
            authLoading: false,
        });
    });

    it("shows the confirmation instructions on a dedicated route", () => {
        render(withIntl(<SignupCheckEmailPage />));

        expect(
            screen.getByRole("heading", { name: "Verifique seu e-mail" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Voltar para o login" }),
        ).toHaveAttribute("href", "/login");
    });

    it("redirects authenticated users to onboarding", async () => {
        useAuth.mockReturnValue({
            isAuthenticated: true,
            authLoading: false,
        });

        render(withIntl(<SignupCheckEmailPage />));

        await waitFor(() => {
            expect(replace).toHaveBeenCalledWith("/onboarding/profile");
        });
        expect(
            screen.queryByRole("heading", { name: "Verifique seu e-mail" }),
        ).not.toBeInTheDocument();
    });
});
