import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingGate } from "./OnboardingGate";

const state = vi.hoisted(() => ({
    pathname: "/assistant",
    profile: {
        displayName: "Alex",
        onboardingComplete: false,
    } as { displayName: string | null; onboardingComplete: boolean },
    replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    usePathname: () => state.pathname,
    useRouter: () => ({ replace: state.replace }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: state.profile, loading: false }),
}));

vi.mock("@/app/components/shared/FullScreenLoader", () => ({
    FullScreenLoader: () => <div>Loading</div>,
}));

describe("OnboardingGate", () => {
    beforeEach(() => {
        state.pathname = "/assistant";
        state.profile = {
            displayName: "Alex",
            onboardingComplete: false,
        };
        state.replace.mockReset();
    });

    it("keeps incomplete users out of the main app", async () => {
        render(
            <OnboardingGate>
                <div>Main app</div>
            </OnboardingGate>,
        );

        expect(screen.queryByText("Main app")).not.toBeInTheDocument();
        await waitFor(() =>
            expect(state.replace).toHaveBeenCalledWith("/onboarding/profile"),
        );
    });

    it("allows incomplete users to use onboarding", () => {
        state.pathname = "/onboarding/profile";
        render(
            <OnboardingGate>
                <div>Profile step</div>
            </OnboardingGate>,
        );

        expect(screen.getByText("Profile step")).toBeInTheDocument();
        expect(state.replace).not.toHaveBeenCalled();
    });

    it("allows users without a display name to continue to practice onboarding", () => {
        state.pathname = "/onboarding/practice";
        state.profile = {
            displayName: null,
            onboardingComplete: false,
        };
        render(
            <OnboardingGate>
                <div>Practice step</div>
            </OnboardingGate>,
        );

        expect(screen.getByText("Practice step")).toBeInTheDocument();
        expect(state.replace).not.toHaveBeenCalled();
    });

    it.each([
        "/login/sso",
        "/reset-password",
        "/forgot-password",
        "/verify-mfa",
    ])(
        "lets incomplete users reach the credential-recovery page %s",
        (path) => {
            state.pathname = path;
            render(
                <OnboardingGate>
                    <div>Recovery page</div>
                </OnboardingGate>,
            );

            expect(screen.getByText("Recovery page")).toBeInTheDocument();
            expect(state.replace).not.toHaveBeenCalled();
        },
    );

    it("redirects completed users away from onboarding", async () => {
        state.pathname = "/onboarding/practice";
        state.profile = {
            displayName: "Alex",
            onboardingComplete: true,
        };
        render(
            <OnboardingGate>
                <div>Practice step</div>
            </OnboardingGate>,
        );

        expect(screen.queryByText("Practice step")).not.toBeInTheDocument();
        await waitFor(() =>
            expect(state.replace).toHaveBeenCalledWith("/assistant"),
        );
    });
});
