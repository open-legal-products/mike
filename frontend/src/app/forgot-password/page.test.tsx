import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import ForgotPasswordPage from "./page";

const { requestPasswordReset } = vi.hoisted(() => ({
    requestPasswordReset: vi.fn(),
}));

vi.mock("@/app/lib/authApi", () => ({
    requestPasswordReset,
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("ForgotPasswordPage", () => {
    beforeEach(() => {
        requestPasswordReset.mockReset();
    });

    it("sends recovery through the shared callback", async () => {
        requestPasswordReset.mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(withIntl(<ForgotPasswordPage />));

        await user.type(
            screen.getByRole("textbox", { name: "E-mail" }),
            "person@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Enviar link de redefinição" }),
        );

        expect(requestPasswordReset).toHaveBeenCalledWith("person@example.com");
        expect(
            await screen.findByRole("heading", { name: "Verifique seu e-mail" }),
        ).toBeInTheDocument();
    });

    it("uses the same response when the request fails", async () => {
        requestPasswordReset.mockRejectedValue(new Error("not found"));
        const user = userEvent.setup();
        render(withIntl(<ForgotPasswordPage />));

        await user.type(
            screen.getByRole("textbox", { name: "E-mail" }),
            "unknown@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Enviar link de redefinição" }),
        );

        expect(
            await screen.findByRole("heading", { name: "Verifique seu e-mail" }),
        ).toBeInTheDocument();
        expect(screen.getByText(/Se existir uma conta/)).toBeInTheDocument();
    });
});
