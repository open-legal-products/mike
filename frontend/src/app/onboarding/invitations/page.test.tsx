import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingInvitationsPage from "./page";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    completeOnboarding: vi.fn(),
    list: vi.fn(),
    accept: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1" }, authLoading: false }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { onboardingComplete: false }, loading: false, completeOnboarding: mocks.completeOnboarding }),
}));
vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...await original<typeof import("@/app/lib/mikeApi")>(),
    listMyOrgInvitations: mocks.list,
    acceptOrgInvitation: mocks.accept,
}));
vi.mock("@/app/components/site-logo", () => ({ SiteLogo: () => <div>Mike</div> }));

const invitation = { id: "invite", org_name: "Example LLP", role: "member" };

describe("OnboardingInvitationsPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        mocks.list.mockResolvedValue([invitation]);
        mocks.accept.mockResolvedValue({ org_id: "org", role: "member" });
        mocks.completeOnboarding.mockResolvedValue(true);
    });

    it("waits for invitations and acceptance before continuing to the model step", async () => {
        let finishLoading!: (invitations: unknown[]) => void;
        mocks.list.mockReturnValue(new Promise((resolve) => { finishLoading = resolve; }));
        let finishAccepting!: (result: unknown) => void;
        mocks.accept.mockReturnValue(new Promise((resolve) => { finishAccepting = resolve; }));
        const user = userEvent.setup();
        render(<OnboardingInvitationsPage />);
        expect(screen.getByText("Step 3 of 4")).toBeVisible();
        expect(screen.getByRole("heading", { name: "Organization invitations" })).toBeVisible();
        expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
        await act(async () => finishLoading([invitation]));
        await user.click(await screen.findByRole("button", { name: "Accept Example LLP" }));
        expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
        await act(async () => finishAccepting({ org_id: "org", role: "member" }));
        expect(window.localStorage.getItem("mike.activeWorkspace.user-1")).toBe("org");
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(mocks.push).toHaveBeenCalledWith("/onboarding/models");
        // Setup is completed on the last step, not here.
        expect(mocks.completeOnboarding).not.toHaveBeenCalled();
        expect(mocks.replace).not.toHaveBeenCalled();
    });

    it("lets users continue without accepting an invitation", async () => {
        const user = userEvent.setup();
        render(<OnboardingInvitationsPage />);
        await screen.findByRole("button", { name: "Accept Example LLP" });
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(mocks.accept).not.toHaveBeenCalled();
        expect(mocks.push).toHaveBeenCalledWith("/onboarding/models");
    });

    it("lets users continue when they have no pending invitations", async () => {
        mocks.list.mockResolvedValue([]);
        const user = userEvent.setup();
        render(<OnboardingInvitationsPage />);
        expect(await screen.findByText(/You have no pending invitations/)).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(mocks.push).toHaveBeenCalledWith("/onboarding/models");
    });

    it("allows returning to practice without completing onboarding", async () => {
        const user = userEvent.setup();
        render(<OnboardingInvitationsPage />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeEnabled());
        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(mocks.push).toHaveBeenCalledWith("/onboarding/practice");
        expect(mocks.completeOnboarding).not.toHaveBeenCalled();
    });
});
