import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import SettingsPage from "./page";

const state = vi.hoisted(() => ({
    push: vi.fn(),
    signOut: vi.fn(),
    deleteAccount: vi.fn(),
    updateEmail: vi.fn(),
    updateDisplayName: vi.fn(),
    updateOrganisation: vi.fn(),
    passwordSet: false,
    profile: {
        displayName: "Alex",
        organisation: "Example LLP",
    },
    user: {
        id: "user-1",
        email: "alex@example.com",
        pendingEmail: null,
        createdWithGoogle: true,
    },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: state.push }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: state.user,
        signOut: state.signOut,
        updateEmail: state.updateEmail,
    }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            ...state.profile,
            passwordSet: state.passwordSet,
            tier: "Free",
        },
        updateDisplayName: state.updateDisplayName,
        updateOrganisation: state.updateOrganisation,
    }),
}));

// The real module is spread back in because userFacingApiError resolves
// MikeApiError from it; a bare object mock leaves that `instanceof` check
// comparing against undefined.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    deleteAccount: state.deleteAccount,
    isMfaRequiredError: vi.fn(() => false),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn(async () => false),
}));

describe("SettingsPage Google email changes", () => {
    beforeEach(() => {
        state.push.mockReset();
        state.signOut.mockReset();
        state.deleteAccount.mockReset();
        state.deleteAccount.mockResolvedValue(undefined);
        state.updateEmail.mockReset();
        state.updateDisplayName.mockReset();
        state.updateDisplayName.mockResolvedValue(true);
        state.updateOrganisation.mockReset();
        state.updateOrganisation.mockResolvedValue(true);
        state.deleteAccount.mockReset();
        state.deleteAccount.mockResolvedValue(undefined);
        state.updateEmail.mockResolvedValue({
            ...state.user,
            email: "alex@example.com",
            pendingEmail: "new@example.com",
        });
        state.passwordSet = false;
        state.profile = {
            displayName: "Alex",
            organisation: "Example LLP",
        };
    });

    it("keeps onboarding organisation out of account settings and places the photo below the name", () => {
        render(<SettingsPage />);
        expect(screen.queryByLabelText("Organisation")).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue("Example LLP")).not.toBeInTheDocument();
        const name = screen.getByLabelText("Display Name");
        const photo = screen.getByText("Profile photo");
        expect(name.compareDocumentPosition(photo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(state.updateOrganisation).not.toHaveBeenCalled();
    });

    it("directs Google-created accounts without a password to Security", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const email = screen.getByPlaceholderText("Enter your email");
        expect(email).toBeDisabled();
        await user.click(
            screen.getByRole("button", { name: "Update" }),
        );

        const dialog = screen.getByRole("dialog", { name: "Change email" });
        expect(dialog).toHaveTextContent(
            "Your account was created with Google. To change your email, first add a password in Settings > Security > Password.",
        );
        expect(state.updateEmail).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Go to Security" }),
        );
        expect(state.push).toHaveBeenCalledWith("/settings/security");
    });

    it("allows the email change after a password has been added", async () => {
        state.passwordSet = true;
        const user = userEvent.setup();
        render(<SettingsPage />);

        const email = screen.getByPlaceholderText("Enter your email");
        await user.clear(email);
        await user.type(email, "new@example.com");
        const emailSection = screen.getByRole("heading", { name: "Email" })
            .parentElement!;
        await user.click(
            emailSection.querySelector<HTMLButtonElement>("button")!,
        );

        await waitFor(() =>
            expect(state.updateEmail).toHaveBeenCalledWith("new@example.com"),
        );
        expect(
            screen.queryByRole("dialog", { name: "Change email" }),
        ).not.toBeInTheDocument();
    });

    it("auto-saves the name when it loses focus", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const name = screen.getByPlaceholderText("Enter your name");
        await user.clear(name);
        await user.type(name, "Alex Chen");
        await user.tab();
        await waitFor(() =>
            expect(state.updateDisplayName).toHaveBeenCalledWith("Alex Chen"),
        );

        expect(state.updateOrganisation).not.toHaveBeenCalled();
    });

    it("keeps the session and shows the reason when deletion is refused", async () => {
        const user = userEvent.setup();
        const detail =
            "You are the only owner of Elite Law LLP. Make another member an owner, or delete the organization, before deleting your account.";
        state.deleteAccount.mockRejectedValue(
            new MikeApiError({
                status: 409,
                code: "org_successor_required",
                message: detail,
            }),
        );
        render(<SettingsPage />);

        await user.click(
            screen.getByRole("button", { name: "Delete account" }),
        );
        await user.click(screen.getByRole("button", { name: "Delete" }));

        // The 409 detail names the blocking organization; a generic "Failed to
        // delete account" would leave the user with no way to unblock it.
        expect(await screen.findByText(detail)).toBeInTheDocument();
        expect(
            screen.getByText("Account deletion failed"),
        ).toBeInTheDocument();
        expect(state.signOut).not.toHaveBeenCalled();
        expect(state.push).not.toHaveBeenCalled();
    });

    it("allows an existing display name to be cleared", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const name = screen.getByPlaceholderText("Enter your name");
        await user.clear(name);
        await user.tab();

        await waitFor(() =>
            expect(state.updateDisplayName).toHaveBeenCalledWith(""),
        );
        expect(screen.queryByText("Name is required.")).not.toBeInTheDocument();
    });

    it("shows a warning popup when account deletion fails", async () => {
        state.deleteAccount.mockRejectedValue(new Error("delete failed"));
        const user = userEvent.setup();
        render(<SettingsPage />);

        await user.click(
            screen.getByRole("button", { name: "Delete account" }),
        );
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(
            await screen.findByText("Account deletion failed"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Your account could not be deleted. Please try again.",
            ),
        ).toBeInTheDocument();
    });
});
