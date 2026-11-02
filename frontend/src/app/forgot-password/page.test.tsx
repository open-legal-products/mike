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
    SiteLogo: () => <div>Mike</div>,
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

    it("uses the same response when the address is rejected", async () => {
        requestPasswordReset.mockRejectedValue(
            Object.assign(new Error("User not found"), {
                status: 404,
                code: "user_not_found",
            }),
        );
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

    it("says the request never went through when the connection drops", async () => {
        requestPasswordReset.mockRejectedValue(new TypeError("Failed to fetch"));
        const user = userEvent.setup();
        render(<ForgotPasswordPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "person@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Send reset link" }),
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mike couldn't reach the server. Check your connection and try again.",
        );
        expect(
            screen.queryByRole("heading", { name: "Check your email" }),
        ).not.toBeInTheDocument();
    });

    it("does not claim mail was sent when the hourly limiter refuses", async () => {
        // 10 resets an hour are rejected before any address is looked at, so
        // saying so cannot reveal whether the account exists — and "check
        // your email" would promise mail nobody sent.
        requestPasswordReset.mockRejectedValue(
            Object.assign(new Error("Too many requests"), {
                status: 429,
                code: "rate_limited",
            }),
        );
        const user = userEvent.setup();
        render(<ForgotPasswordPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "person@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Send reset link" }),
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            /Too many requests/i,
        );
        expect(
            screen.queryByRole("heading", { name: "Check your email" }),
        ).not.toBeInTheDocument();
    });

    it("does not claim mail was sent when the request is refused", async () => {
        requestPasswordReset.mockRejectedValue(
            Object.assign(new Error("Forbidden"), { status: 403 }),
        );
        const user = userEvent.setup();
        render(<ForgotPasswordPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "person@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Send reset link" }),
        );

        expect(await screen.findByRole("alert")).toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: "Check your email" }),
        ).not.toBeInTheDocument();
    });

    it("retries a server failure from the inline error", async () => {
        requestPasswordReset.mockRejectedValueOnce(
            Object.assign(new Error("Internal error"), { status: 500 }),
        );
        requestPasswordReset.mockResolvedValueOnce(undefined);
        const user = userEvent.setup();
        render(<ForgotPasswordPage />);

        await user.type(
            screen.getByRole("textbox", { name: "Email" }),
            "person@example.com",
        );
        await user.click(
            screen.getByRole("button", { name: "Send reset link" }),
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Something went wrong on our side. Try again.",
        );
        await user.click(screen.getByRole("button", { name: "Retry" }));

        expect(requestPasswordReset).toHaveBeenCalledTimes(2);
        expect(
            await screen.findByRole("heading", { name: "Check your email" }),
        ).toBeInTheDocument();
    });
});
