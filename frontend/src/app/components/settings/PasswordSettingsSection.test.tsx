import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
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
        render(withIntl(<PasswordSettingsSection />));

        expect(screen.getByText("Definir senha", { selector: "p" })).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Definir senha" }),
        );

        const dialog = screen.getByRole("dialog", { name: "Definir senha" });
        await waitFor(() =>
            expect(within(dialog).getByRole("button", { name: "Fechar" })).toHaveFocus(),
        );
        await user.type(
            within(dialog).getByLabelText("Senha"),
            "securepass1",
        );
        await user.type(
            within(dialog).getByLabelText("Confirmar senha"),
            "securepass1",
        );
        await user.click(
            within(dialog).getByRole("button", { name: "Definir senha" }),
        );

        await waitFor(() =>
            expect(state.setPassword).toHaveBeenCalledWith("securepass1"),
        );
        expect(screen.getByText("Senha adicionada à sua conta.")).toBeVisible();
    });

    it("keeps the reset-email flow for accounts that already have a password", async () => {
        state.passwordSet = true;
        const user = userEvent.setup();
        render(withIntl(<PasswordSettingsSection />));

        expect(screen.getByText("Redefinir senha")).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Enviar e-mail de redefinição" }),
        );

        await waitFor(() =>
            expect(state.requestPasswordReset).toHaveBeenCalledWith(
                "alex@example.com",
            ),
        );
    });
});
