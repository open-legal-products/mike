import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SecurityPage from "./page";
import { AuthApiError } from "@/app/lib/authApi";

const {
    challengeMfa,
    enrollMfa,
    getMfaAssurance,
    listMfaFactors,
    unenrollMfa,
    verifyMfa,
} = vi.hoisted(() => ({
    challengeMfa: vi.fn(),
    enrollMfa: vi.fn(),
    getMfaAssurance: vi.fn(),
    listMfaFactors: vi.fn(),
    unenrollMfa: vi.fn(),
    verifyMfa: vi.fn(),
}));

vi.mock("@/app/lib/authApi", async (importOriginal) => ({
    // The page narrows with `instanceof AuthApiError`, so the real class stays.
    AuthApiError: (await importOriginal<typeof import("@/app/lib/authApi")>())
        .AuthApiError,
    challengeMfa,
    enrollMfa,
    getMfaAssurance,
    listMfaFactors,
    unenrollMfa,
    verifyMfa,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { mfaOnLogin: false },
        updateMfaOnLogin: vi.fn(async () => true),
    }),
}));

vi.mock("@/app/lib/mikeApi", () => ({ isMfaRequiredError: () => false }));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn(async () => false),
}));

vi.mock("@/app/components/settings/PasswordSettingsSection", () => ({
    PasswordSettingsSection: () => null,
}));

describe("SecurityPage", () => {
    beforeEach(() => {
        challengeMfa.mockReset();
        enrollMfa.mockReset();
        getMfaAssurance.mockReset();
        listMfaFactors.mockReset();
        unenrollMfa.mockReset();
        verifyMfa.mockReset();
        listMfaFactors.mockResolvedValue({ all: [], totp: [] });
        getMfaAssurance.mockResolvedValue({
            currentLevel: "aal1",
            nextLevel: "aal1",
        });
    });

    it("says the connection failed when the settings can't be loaded", async () => {
        listMfaFactors.mockRejectedValue(new TypeError("Failed to fetch"));

        render(<SecurityPage />);

        expect(
            await screen.findByText(
                "Mike couldn't reach the server. Check your connection and try again.",
            ),
        ).toBeInTheDocument();
    });

    it("offers support when the server fails to load the settings", async () => {
        listMfaFactors.mockRejectedValue(
            new AuthApiError(500, null, "Authentication could not be completed."),
        );

        render(<SecurityPage />);

        expect(
            await screen.findByText("Something went wrong on our side. Try again."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Contact support" }),
        ).toHaveAttribute("href", expect.stringContaining("will@mikeoss.com"));
    });

    it("retries enrollment on the provider's name-conflict code", async () => {
        const user = (await import("@testing-library/user-event")).default.setup();
        enrollMfa
            .mockRejectedValueOnce(
                new AuthApiError(
                    422,
                    "mfa_factor_name_conflict",
                    // Deliberately not the sentence the old check matched.
                    "This friendly name is taken",
                ),
            )
            .mockResolvedValueOnce({
                id: "factor-1",
                totp: { qr_code: "data:image/png;base64,x", secret: "SECRET" },
            });
        challengeMfa.mockResolvedValue({ id: "challenge-1" });

        render(<SecurityPage />);
        await user.click(await screen.findByRole("button", { name: "Set up" }));
        await user.click(
            await screen.findByRole("button", { name: "Continue" }),
        );

        await waitFor(() => expect(enrollMfa).toHaveBeenCalledTimes(2));
        expect(enrollMfa.mock.calls[1][0]).toMatch(/^Mike /);
    });
});
