import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResetPasswordPage from "./page";

const { getAuthSession, updateAuthPassword, searchParams } = vi.hoisted(() => ({
    getAuthSession: vi.fn(),
    updateAuthPassword: vi.fn(),
    searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
    useSearchParams: () => searchParams,
}));

vi.mock("@/app/lib/authApi", () => ({ getAuthSession, updateAuthPassword }));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

async function submitPassword(password: string) {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("New password"), password);
    await user.type(screen.getByLabelText("Confirm new password"), password);
    await user.click(screen.getByRole("button", { name: "Update password" }));
    return user;
}

describe("ResetPasswordPage", () => {
    beforeEach(() => {
        getAuthSession.mockReset();
        updateAuthPassword.mockReset();
        getAuthSession.mockResolvedValue({ id: "user-1" });
    });

    it("says what is wrong with a password the server rejects", async () => {
        updateAuthPassword.mockRejectedValue(
            Object.assign(new Error("Password is too weak"), {
                status: 422,
                code: "weak_password",
            }),
        );
        render(<ResetPasswordPage />);

        await submitPassword("correct-horse-battery");

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Choose a stronger password: at least 10 characters, mixing letters, numbers, and symbols.",
        );
    });

    it("refuses a password past bcrypt's limit before calling the API", async () => {
        render(<ResetPasswordPage />);

        await submitPassword("x".repeat(73));

        expect(updateAuthPassword).not.toHaveBeenCalled();
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Password must be at most 72 UTF-8 bytes. Accented characters and emoji can use more than one byte.",
        );
    });

    it("blames the connection, not the link, when the request never lands", async () => {
        getAuthSession.mockRejectedValue(new TypeError("Failed to fetch"));
        render(<ResetPasswordPage />);

        expect(
            await screen.findByText(
                "Mike couldn't reach the server. Check your connection and try again.",
            ),
        ).toBeInTheDocument();
    });

    it("still calls a spent link spent", async () => {
        getAuthSession.mockRejectedValue(
            Object.assign(new Error("Session not found"), { status: 401 }),
        );
        render(<ResetPasswordPage />);

        expect(
            await screen.findByText(
                "This password-reset link is invalid or has expired.",
            ),
        ).toBeInTheDocument();
    });
});
