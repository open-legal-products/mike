import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import OnboardingProfilePage from "./page";

const { push, replace, reloadProfile, updateUserProfile } = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    reloadProfile: vi.fn(),
    updateUserProfile: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, replace }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "user-1", email: "alex@example.com" },
        authLoading: false,
    }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            displayName: "Alex",
            organisation: "",
        },
        loading: false,
        reloadProfile,
    }),
}));

vi.mock("@/app/lib/mikeApi", () => ({ updateUserProfile }));
vi.mock("@/app/components/site-logo", () => ({
    SiteLogo: () => <div>Mike</div>,
}));

describe("OnboardingProfilePage", () => {
    beforeEach(() => {
        push.mockReset();
        replace.mockReset();
        reloadProfile.mockReset();
        reloadProfile.mockResolvedValue(undefined);
        updateUserProfile.mockReset();
        updateUserProfile.mockResolvedValue({});
    });

    it("allows an empty name and saves profile details before continuing", async () => {
        const user = userEvent.setup();
        render(withIntl(<OnboardingProfilePage />));

        const name = screen.getByRole("textbox", { name: "Nome" });
        await user.clear(name);
        await user.type(
            screen.getByRole("textbox", { name: "Organização" }),
            "Example LLP",
        );
        await user.click(screen.getByRole("button", { name: "Continuar" }));

        await waitFor(() =>
            expect(updateUserProfile).toHaveBeenCalledWith({
                displayName: null,
                organisation: "Example LLP",
            }),
        );
        expect(reloadProfile).toHaveBeenCalled();
        expect(push).toHaveBeenCalledWith("/onboarding/practice");
    });
});
