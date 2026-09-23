import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordSettingsSection } from "./PasswordSettingsSection";

const state = vi.hoisted(() => ({
    user: {
        id: "user-1",
        email: "alex@example.com",
        pendingEmail: null,
        createdWithGoogle: true,
    },
    passwordSet: false,
    setPassword: vi.fn(),
    syncPasswordSet: vi.fn(),
    requestPasswordReset: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: state.user, setPassword: state.setPassword }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { passwordSet: state.passwordSet },
        syncPasswordSet: state.syncPasswordSet,
    }),
}));

vi.mock("@/app/lib/authApi", () => ({
    requestPasswordReset: state.requestPasswordReset,
}));

describe("PasswordSettingsSection", () => {
    beforeEach(() => {
        state.user.createdWithGoogle = true;
        state.passwordSet = false;
        state.setPassword.mockReset();
        state.setPassword.mockResolvedValue(undefined);
        state.syncPasswordSet.mockReset();
        state.syncPasswordSet.mockImplementation(async () => {
            state.passwordSet = true;
            return true;
        });
        state.requestPasswordReset.mockReset();
        state.requestPasswordReset.mockResolvedValue(undefined);
    });

    it("lets a Google-created account add its first password", async () => {
        const user = userEvent.setup();
        render(<PasswordSettingsSection />);

        expect(screen.getByText("Set password", { selector: "p" })).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Set password" }),
        );

        const dialog = screen.getByRole("dialog", { name: "Set password" });
        await waitFor(() =>
            expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus(),
        );
        await user.type(
            within(dialog).getByLabelText("Password"),
            "securepass1",
        );
        await user.type(
            within(dialog).getByLabelText("Confirm password"),
            "securepass1",
        );
        await user.click(
            within(dialog).getByRole("button", { name: "Set password" }),
        );

        await waitFor(() =>
            expect(state.setPassword).toHaveBeenCalledWith("securepass1"),
        );
        expect(screen.getByText("Password added to your account.")).toBeVisible();
    });

    it("keeps the reset-email flow for accounts that already have a password", async () => {
        state.passwordSet = true;
        const user = userEvent.setup();
        render(<PasswordSettingsSection />);

        expect(screen.getByText("Reset password")).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Send reset email" }),
        );

        await waitFor(() =>
            expect(state.requestPasswordReset).toHaveBeenCalledWith(
                "alex@example.com",
            ),
        );
    });

    async function openAndSubmit(password: string) {
        const user = userEvent.setup();
        render(<PasswordSettingsSection />);
        await user.click(screen.getByRole("button", { name: "Set password" }));
        const dialog = screen.getByRole("dialog", { name: "Set password" });
        // Set the value in one event: typing character by character into a
        // controlled field inside the modal's focus trap is needlessly slow.
        fireEvent.change(within(dialog).getByLabelText("Password"), {
            target: { value: password },
        });
        fireEvent.change(within(dialog).getByLabelText("Confirm password"), {
            target: { value: password },
        });
        await user.click(
            within(dialog).getByRole("button", { name: "Set password" }),
        );
        return dialog;
    }

    it("uses Mike's password policy rather than the provider's wording", async () => {
        state.setPassword.mockRejectedValue(
            Object.assign(new Error("Password should be at least 6 characters"), {
                status: 422,
                code: "weak_password",
            }),
        );

        const dialog = await openAndSubmit("securepass1");

        await waitFor(() =>
            expect(within(dialog).getByRole("alert")).toHaveTextContent(
                "Choose a stronger password: at least 10 characters, mixing letters, numbers, and symbols.",
            ),
        );
        expect(
            screen.queryByText(/at least 6 characters/),
        ).not.toBeInTheDocument();
    });

    it("refuses a password past bcrypt's limit before calling the API", async () => {
        const dialog = await openAndSubmit("x".repeat(73));

        expect(state.setPassword).not.toHaveBeenCalled();
        expect(within(dialog).getByRole("alert")).toHaveTextContent(
            "Password must be at most 72 UTF-8 bytes. Accented characters and emoji can use more than one byte.",
        );
    });

    it("says the reset email did not go out when the connection drops", async () => {
        state.passwordSet = true;
        state.requestPasswordReset.mockRejectedValue(
            new TypeError("Failed to fetch"),
        );
        const user = userEvent.setup();
        render(<PasswordSettingsSection />);

        await user.click(
            screen.getByRole("button", { name: "Send reset email" }),
        );

        await waitFor(() =>
            expect(
                screen.getByText(
                    "Mike couldn't reach the server. Check your connection and try again.",
                ),
            ).toBeVisible(),
        );
    });
});
