import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { SsoAuthButton } from "./SsoAuthButton";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
}));

describe("SsoAuthButton", () => {
    beforeEach(() => {
        push.mockReset();
    });

    it("renders immediately and opens the dedicated SSO login screen", async () => {
        render(withIntl(<SsoAuthButton />));

        const button = screen.getByRole("button", {
            name: "Continuar com SSO",
        });
        expect(button).toHaveAttribute("type", "button");
        await userEvent.click(button);
        expect(push).toHaveBeenCalledWith("/login/sso");
    });

    it("respects the parent loading state", () => {
        render(withIntl(<SsoAuthButton disabled />));
        expect(
            screen.getByRole("button", { name: "Continuar com SSO" }),
        ).toBeDisabled();
    });
});
