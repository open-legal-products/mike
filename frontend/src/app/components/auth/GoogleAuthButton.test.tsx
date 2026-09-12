import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
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
        render(withIntl(<GoogleAuthButton onError={onError} />));

        await user.click(
            screen.getByRole("button", { name: "Continuar com Google" }),
        );

        expect(startGoogleOAuth).toHaveBeenCalledWith("/onboarding/profile");
        expect(onError).toHaveBeenCalledWith("");
        expect(
            screen.getByRole("button", { name: "Redirecionando..." }),
        ).toBeDisabled();
    });

    it("surfaces provider startup errors and re-enables the button", async () => {
        startGoogleOAuth.mockRejectedValue(
            new Error("Google provider is unavailable"),
        );
        const onError = vi.fn();
        const user = userEvent.setup();
        render(withIntl(<GoogleAuthButton onError={onError} />));

        await user.click(
            screen.getByRole("button", { name: "Continuar com Google" }),
        );

        expect(onError).toHaveBeenLastCalledWith(
            "Google provider is unavailable",
        );
        expect(
            screen.getByRole("button", { name: "Continuar com Google" }),
        ).toBeEnabled();
    });
});
