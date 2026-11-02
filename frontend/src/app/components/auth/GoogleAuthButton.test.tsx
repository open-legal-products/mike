import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthButton } from "./GoogleAuthButton";

const { startGoogleOAuth } = vi.hoisted(() => ({
    startGoogleOAuth: vi.fn(),
}));

vi.mock("@/app/lib/authApi", () => ({
    startGoogleOAuth,
}));

describe("GoogleAuthButton", () => {
    beforeEach(() => {
        startGoogleOAuth.mockReset();
    });

    it("starts Google OAuth with the shared auth callback", async () => {
        startGoogleOAuth.mockResolvedValue({ url: "https://accounts.example.test" });
        const onError = vi.fn();
        const user = userEvent.setup();
        render(<GoogleAuthButton onError={onError} />);

        await user.click(
            screen.getByRole("button", { name: "Continue with Google" }),
        );

        expect(startGoogleOAuth).toHaveBeenCalledWith("/onboarding/profile");
        expect(onError).toHaveBeenCalledWith(null);
        expect(
            screen.getByRole("button", { name: "Continuing…" }),
        ).toBeDisabled();
    });

    it("never forwards the provider's own error text", async () => {
        startGoogleOAuth.mockRejectedValue(
            new Error("invalid_client: unauthorized_client at oauth.ts:88"),
        );
        const onError = vi.fn();
        const user = userEvent.setup();
        render(<GoogleAuthButton onError={onError} />);

        await user.click(
            screen.getByRole("button", { name: "Continue with Google" }),
        );

        expect(onError).toHaveBeenLastCalledWith(
            expect.objectContaining({
                message:
                    "Unable to continue with Google. Try again, or log in with your email and password.",
            }),
        );
        expect(
            screen.getByRole("button", { name: "Continue with Google" }),
        ).toBeEnabled();
    });

    it("explains a disabled provider by its code", async () => {
        startGoogleOAuth.mockRejectedValue(
            Object.assign(new Error("Unsupported provider"), {
                status: 400,
                code: "provider_disabled",
            }),
        );
        const onError = vi.fn();
        const user = userEvent.setup();
        render(<GoogleAuthButton onError={onError} />);

        await user.click(
            screen.getByRole("button", { name: "Continue with Google" }),
        );

        expect(onError).toHaveBeenLastCalledWith(
            expect.objectContaining({
                message:
                    "Google sign-in is turned off for this workspace. Use your email and password instead.",
            }),
        );
    });

    it("tells the user the connection failed when the request never lands", async () => {
        startGoogleOAuth.mockRejectedValue(new TypeError("Failed to fetch"));
        const onError = vi.fn();
        const user = userEvent.setup();
        render(<GoogleAuthButton onError={onError} />);

        await user.click(
            screen.getByRole("button", { name: "Continue with Google" }),
        );

        expect(onError).toHaveBeenLastCalledWith(
            expect.objectContaining({
                message:
                    "Mike couldn't reach the server. Check your connection and try again.",
            }),
        );
    });
});
