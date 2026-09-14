import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ForgotPasswordPage from "./page";

const { requestPasswordReset } = vi.hoisted(() => ({
    requestPasswordReset: vi.fn(),
}));

vi.mock("@/app/lib/authApi", () => ({
    requestPasswordReset,
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Weybre AI</div>,
}));

describe("ForgotPasswordPage", () => {
    beforeEach(() => {
        requestPasswordReset.mockReset();
    });

    it("sends recovery through the shared callback", async () => {
        requestPasswordReset.mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(<ForgotPasswordPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "person@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Send reset link" }),
        );

        expect(requestPasswordReset).toHaveBeenCalledWith("person@example.com");
        expect(
            await screen.findByRole("heading", { name: "Check your email" }),
        ).toBeInTheDocument();
    });

    it("uses the same response when the request fails", async () => {
        requestPasswordReset.mockRejectedValue(new Error("not found"));
        const user = userEvent.setup();
        render(<ForgotPasswordPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "unknown@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Send reset link" }),
        );

        expect(
            await screen.findByRole("heading", { name: "Check your email" }),
        ).toBeInTheDocument();
        expect(screen.getByText(/If an account exists/)).toBeInTheDocument();
    });
});
