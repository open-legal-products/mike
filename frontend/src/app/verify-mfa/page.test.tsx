import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VerifyMfaPage from "./page";

const {
    authState,
    router,
    searchParams,
    challengeAndVerifyMfa,
    listMfaFactors,
    needsMfaVerification,
    replace,
    signOut,
} = vi.hoisted(() => ({
    authState: {
        user: { id: "user-1" },
        authLoading: false,
    },
    router: { replace: undefined as unknown as ReturnType<typeof vi.fn> },
    searchParams: new URLSearchParams(),
    challengeAndVerifyMfa: vi.fn(),
    listMfaFactors: vi.fn(),
    needsMfaVerification: vi.fn(),
    replace: vi.fn(),
    signOut: vi.fn(),
}));

router.replace = replace;

vi.mock("next/navigation", () => ({
    useRouter: () => router,
    useSearchParams: () => searchParams,
}));

vi.mock("@/app/lib/authApi", () => ({
    challengeAndVerifyMfa,
    listMfaFactors,
}));

// Stable identities: a fresh router or user object on each render would
// re-run the page's load effect and wipe the typed code between keystrokes.
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ ...authState, signOut }),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    needsMfaVerification,
    VerificationCodeInput: ({
        value,
        onChange,
    }: {
        value: string;
        onChange: (next: string) => void;
    }) => (
        <input
            aria-label="Code"
            value={value}
            onChange={(event) => onChange(event.target.value)}
        />
    ),
}));

vi.mock("@/app/components/shared/MfaLoginGate", () => ({
    markMfaVerifiedForGate: vi.fn(),
}));

vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

async function enterCode() {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    return user;
}

describe("VerifyMfaPage", () => {
    beforeEach(() => {
        challengeAndVerifyMfa.mockReset();
        listMfaFactors.mockReset();
        needsMfaVerification.mockReset();
        replace.mockReset();
        signOut.mockReset();
        needsMfaVerification.mockResolvedValue(true);
        listMfaFactors.mockResolvedValue({
            all: [],
            totp: [{ id: "factor-1", factor_type: "totp" }],
        });
    });

    it("names the reason a code was refused", async () => {
        challengeAndVerifyMfa.mockRejectedValue(
            Object.assign(new Error("Invalid TOTP code entered"), {
                status: 422,
                code: "mfa_verification_failed",
            }),
        );
        render(<VerifyMfaPage />);

        await enterCode();

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "That code is incorrect. Enter the current six-digit code from your authenticator app.",
        );
    });

    it("separates a dropped connection from a wrong code", async () => {
        challengeAndVerifyMfa.mockRejectedValue(new TypeError("Failed to fetch"));
        render(<VerifyMfaPage />);

        await enterCode();

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mike couldn't reach the server. Check your connection and try again.",
        );
    });

    it("explains why the authenticator list could not load", async () => {
        listMfaFactors.mockRejectedValue(
            Object.assign(new Error("boom"), { status: 500 }),
        );
        render(<VerifyMfaPage />);

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Something went wrong on our side. Try again.",
        );
        expect(
            screen.getByRole("link", { name: "Contact support" }),
        ).toHaveAttribute("href", expect.stringContaining("will@mikeoss.com"));
    });
});
