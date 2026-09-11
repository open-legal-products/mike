import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
        render(<SsoAuthButton />);

        const button = screen.getByRole("button", {
            name: "Continue with SSO",
        });
        expect(button).toHaveAttribute("type", "button");
        await userEvent.click(button);
        expect(push).toHaveBeenCalledWith("/login/sso");
    });

    it("respects the parent loading state", () => {
        render(<SsoAuthButton disabled />);
        expect(
            screen.getByRole("button", { name: "Continue with SSO" }),
        ).toBeDisabled();
    });
});
