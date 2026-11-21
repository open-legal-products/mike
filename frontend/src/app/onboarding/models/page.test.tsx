import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY_PROVIDERS } from "@/app/lib/apiKeyState";
import OnboardingModelsPage from "./page";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    completeOnboarding: vi.fn(),
    updateApiKey: vi.fn(),
    updateApiKeyEnabled: vi.fn(),
    listOrgs: vi.fn(),
    getOrgApiKeys: vi.fn(),
    apiKeys: {} as Record<string, { configured: boolean; enabled?: boolean; source: string | null }>,
}));

vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1" }, authLoading: false }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { onboardingComplete: false, apiKeys: mocks.apiKeys, apiKeySettings: {} },
        loading: false,
        completeOnboarding: mocks.completeOnboarding,
        updateApiKey: mocks.updateApiKey,
        updateApiKeyEnabled: mocks.updateApiKeyEnabled,
    }),
}));
vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...await original<typeof import("@/app/lib/mikeApi")>(),
    listOrgs: mocks.listOrgs,
    getOrgApiKeys: mocks.getOrgApiKeys,
}));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/app/components/settings/RouterSettingsSection", () => ({
    RouterSettingsSection: () => null,
}));
vi.mock("@/app/components/site-logo", () => ({ SiteLogo: () => <div>Mike</div> }));

function noKeys() {
    return Object.fromEntries(
        API_KEY_PROVIDERS.map((provider) => [provider, { configured: false, source: null }]),
    );
}

const DEFAULT_COPY = /Add an API key for at least one provider/;

describe("OnboardingModelsPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        mocks.apiKeys = noKeys();
        mocks.completeOnboarding.mockResolvedValue(true);
        mocks.updateApiKey.mockResolvedValue(true);
        mocks.listOrgs.mockResolvedValue([]);
        mocks.getOrgApiKeys.mockResolvedValue({ effective: {} });
    });

    it("offers every provider and finishes onboarding without a key", async () => {
        const user = userEvent.setup();
        render(<OnboardingModelsPage />);
        expect(screen.getByText("Step 4 of 4")).toBeVisible();
        expect(screen.getByRole("heading", { name: "Connect a model" })).toBeVisible();
        expect(screen.getByText(DEFAULT_COPY)).toBeVisible();
        const available = screen.getByRole("region", { name: "Available Providers" });
        expect(within(available).getAllByRole("button", { name: /^Add / })).toHaveLength(13);
        expect(screen.getByText(/No saved providers yet/)).toBeVisible();

        const finish = screen.getByRole("button", { name: "Finish" });
        expect(finish).toBeEnabled();
        await user.click(finish);
        expect(mocks.completeOnboarding).toHaveBeenCalledExactlyOnceWith();
        expect(mocks.replace).toHaveBeenCalledWith("/assistant");
        expect(mocks.listOrgs).not.toHaveBeenCalled();
    });

    it("saves a key through the same provider dialog as settings", async () => {
        const user = userEvent.setup();
        render(<OnboardingModelsPage />);
        await user.click(screen.getByRole("button", { name: "Add OpenAI" }));
        const dialog = screen.getByRole("dialog", { name: "OpenAI" });
        await user.type(within(dialog).getByLabelText("OpenAI API Key"), "sk-test");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        expect(mocks.updateApiKey).toHaveBeenCalledWith("openai", "sk-test", undefined);
        expect(mocks.completeOnboarding).not.toHaveBeenCalled();
    });

    it("reports a saved key and lists its provider under Saved", () => {
        mocks.apiKeys.openai = { configured: true, enabled: true, source: "user" };
        render(<OnboardingModelsPage />);
        expect(screen.getByText(/Your key is saved/)).toBeVisible();
        expect(
            within(screen.getByRole("region", { name: "Saved Providers" })).getByRole("switch", { name: "OpenAI provider" }),
        ).toBeChecked();
    });

    it("says when the deployment already provides models", () => {
        mocks.apiKeys.claude = { configured: true, enabled: true, source: "env" };
        render(<OnboardingModelsPage />);
        expect(screen.getByText(/This deployment already provides models/)).toBeVisible();
        // An environment key is not the person's own: nothing is Saved yet.
        expect(screen.getByText(/No saved providers yet/)).toBeVisible();
    });

    it("names the organization just joined when it has models", async () => {
        window.localStorage.setItem("mike.activeWorkspace.user-1", "org-1");
        mocks.listOrgs.mockResolvedValue([{ id: "org-1", name: "Example LLP", role: "member" }]);
        mocks.getOrgApiKeys.mockResolvedValue({ effective: { claude: true, sources: { claude: "org" } } });
        render(<OnboardingModelsPage />);
        expect(await screen.findByText(/You joined Example LLP, and its models are available/)).toBeVisible();
        expect(mocks.getOrgApiKeys).toHaveBeenCalledWith("org-1");
        expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
    });

    it("keeps the general wording when the joined organization has no models", async () => {
        window.localStorage.setItem("mike.activeWorkspace.user-1", "org-1");
        mocks.listOrgs.mockResolvedValue([{ id: "org-1", name: "Example LLP", role: "member" }]);
        mocks.getOrgApiKeys.mockResolvedValue({ effective: { claude: false } });
        render(<OnboardingModelsPage />);
        await vi.waitFor(() => expect(mocks.getOrgApiKeys).toHaveBeenCalledWith("org-1"));
        expect(screen.getByText(DEFAULT_COPY)).toBeVisible();
        expect(screen.queryByText(/You joined/)).not.toBeInTheDocument();
    });

    it("returns to invitations without completing onboarding", async () => {
        const user = userEvent.setup();
        render(<OnboardingModelsPage />);
        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(mocks.push).toHaveBeenCalledWith("/onboarding/invitations");
        expect(mocks.completeOnboarding).not.toHaveBeenCalled();
    });

    it("allows retrying when completion fails", async () => {
        mocks.completeOnboarding.mockResolvedValueOnce(false);
        const user = userEvent.setup();
        render(<OnboardingModelsPage />);
        await user.click(screen.getByRole("button", { name: "Finish" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to finish setup");
        expect(mocks.replace).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Finish" }));
        expect(mocks.completeOnboarding).toHaveBeenCalledTimes(2);
        expect(mocks.replace).toHaveBeenCalledWith("/assistant");
    });
});
