import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import AppearancePage from "./page";

const { updateDarkMode, profile } = vi.hoisted(() => ({
    updateDarkMode: vi.fn(),
    profile: { darkMode: false },
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile,
        updateDarkMode,
    }),
}));

describe("AppearancePage", () => {
    beforeEach(() => {
        updateDarkMode.mockReset();
        updateDarkMode.mockResolvedValue(undefined);
        profile.darkMode = false;
    });

    it("saves dark mode without rendering a decorative card icon", async () => {
        const user = userEvent.setup();
        const { container } = render(withIntl(<AppearancePage />));

        expect(
            screen.getByRole("heading", { name: "Aparência" }),
        ).toBeVisible();
        expect(screen.getByText("Modo escuro")).toBeVisible();
        expect(container.querySelector("svg")).toBeNull();

        const toggle = screen.getByRole("switch", { name: "Modo escuro" });
        expect(toggle).toHaveAttribute("aria-checked", "false");

        await user.click(toggle);
        expect(updateDarkMode).toHaveBeenCalledWith(true);
    });

    it("reports a failed change without leaking the raw error", async () => {
        const user = userEvent.setup();
        updateDarkMode.mockRejectedValue(new Error("pg: connection refused"));
        render(withIntl(<AppearancePage />));

        await user.click(screen.getByRole("switch", { name: "Modo escuro" }));
        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Não foi possível atualizar a configuração de aparência.",
            ),
        );
        expect(screen.queryByText(/connection refused/i)).not.toBeInTheDocument();
    });

});
