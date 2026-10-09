import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
    getUserProfile,
    updateUserProfile,
    updateChatModel,
    updateTabularChatModel,
    updateTabularChatReasoningLevel,
    updateLastSelectedChatSettings,
    saveApiKey,
} = vi.hoisted(() => ({
    saveApiKey: vi.fn(),
    getUserProfile: vi.fn(),
    updateUserProfile: vi.fn(),
    updateChatModel: vi.fn(),
    updateTabularChatModel: vi.fn(),
    updateTabularChatReasoningLevel: vi.fn(),
    updateLastSelectedChatSettings: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "u1" },
        isAuthenticated: true,
    }),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getUserProfile: (...args: unknown[]) => getUserProfile(...args),
    updateUserProfile: (...args: unknown[]) => updateUserProfile(...args),
    updateChatModel: (...args: unknown[]) => updateChatModel(...args),
    updateTabularChatModel: (...args: unknown[]) =>
        updateTabularChatModel(...args),
    updateTabularChatReasoningLevel: (...args: unknown[]) =>
        updateTabularChatReasoningLevel(...args),
    updateLastSelectedChatSettings: (...args: unknown[]) =>
        updateLastSelectedChatSettings(...args),
    saveApiKey: (...args: unknown[]) => saveApiKey(...args),
}));

import { UserProfileProvider, useUserProfile } from "./UserProfileContext";
import { MikeApiError } from "@/app/lib/mikeApi";
import { subscribeToTabularChatSettingsUpdates } from "@/app/lib/tabularChatSettingsEvents";

function apiProfile(darkMode: boolean) {
    return {
        displayName: "Ada",
        organisation: null,
        messageCreditsUsed: 0,
        creditsResetDate: "2999-01-01T00:00:00.000Z",
        creditsRemaining: 999999,
        tier: "Free",
        titleModel: "gemini-3.1-flash-lite-preview",
        tabularModel: "gemini-3-flash-preview",
        memoryCuratorModel: null,
        lastSelectedChatModel: null,
        lastSelectedReasoningLevel: "high",
        mfaOnLogin: false,
        legalResearchUs: true,
        emailIntegrationEnabled: false,
        darkMode,
        featureFlags: {},
        deploymentModules: {},
        apiKeyStatus: {
            claude: false,
            kimi: false,
            gemini: false,
            openai: false,
            openrouter: false,
            courtlistener: false,
            sources: {},
        },
    };
}

function ThemeControls() {
    const { profile, updateDarkMode } = useUserProfile();
    return (
        <>
            <span data-testid="mode">
                {profile?.darkMode ? "dark" : "light"}
            </span>
            <button onClick={() => void updateDarkMode(false)}>Light</button>
            <button onClick={() => void updateDarkMode(true)}>Dark</button>
        </>
    );
}

function LastSelectedModel() {
    const { profile, persistChatModelSelection } = useUserProfile();
    return (
        <>
            <span>{profile?.lastSelectedChatModel ?? "none"}</span>
            <button
                onClick={() => void persistChatModelSelection("gpt-5.6-luna")}
            >
                Select model
            </button>
        </>
    );
}

function ProviderState() {
    const { profile } = useUserProfile();
    return <span data-testid="provider-state">{JSON.stringify(profile?.apiKeys.openai)}</span>;
}

function TabularChatSettings() {
    const { persistChatModelSelection, persistChatReasoningSelection } =
        useUserProfile();
    const selectionKey = "tabular-review-chat:r1:c1";
    return (
        <>
            <button
                onClick={() =>
                    void persistChatModelSelection("gpt-5.6-luna", selectionKey)
                }
            >
                Select tabular model
            </button>
            <button
                onClick={() =>
                    void persistChatReasoningSelection("low", selectionKey)
                }
            >
                Select tabular reasoning
            </button>
        </>
    );
}

beforeEach(() => {
    getUserProfile.mockResolvedValue(apiProfile(true));
    updateUserProfile.mockImplementation(
        ({ darkMode = true }: { darkMode?: boolean }) =>
            Promise.resolve(apiProfile(darkMode)),
    );
    updateLastSelectedChatSettings.mockResolvedValue(apiProfile(true));
    updateTabularChatModel.mockResolvedValue({});
    updateTabularChatReasoningLevel.mockResolvedValue({});
});

afterEach(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    vi.clearAllMocks();
});

it("restores a disabled provider's saved-key state when loading the profile", async () => {
    const profile = apiProfile(false);
    getUserProfile.mockResolvedValue({
        ...profile,
        apiKeyStatus: {
            ...profile.apiKeyStatus,
            openai: false,
            sources: { openai: "user" },
            enabled: { openai: false },
        },
    });
    render(<UserProfileProvider><ProviderState /></UserProfileProvider>);
    await waitFor(() => expect(screen.getByTestId("provider-state")).toHaveTextContent(
        JSON.stringify({ configured: false, enabled: false, source: "user" }),
    ));
});

it("passes a rejected key's 400 to the caller and reports other failures as false", async () => {
    const outcomes: string[] = [];
    function SaveKey() {
        const { profile, updateApiKey } = useUserProfile();
        if (!profile) return null;
        return (
            <button
                onClick={() =>
                    void updateApiKey("custom", "sk-custom", {
                        baseUrl: "https://10.0.0.1/v1",
                    }).then(
                        (ok) => outcomes.push(`resolved:${ok}`),
                        (error: MikeApiError) =>
                            outcomes.push(`rejected:${error.status}`),
                    )
                }
            >
                Save key
            </button>
        );
    }
    saveApiKey
        .mockRejectedValueOnce(
            new MikeApiError({ message: "A public https base URL is required.", status: 400 }),
        )
        .mockRejectedValueOnce(new Error("network down"));
    render(<UserProfileProvider><SaveKey /></UserProfileProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Save key" }));
    await waitFor(() => expect(outcomes).toEqual(["rejected:400"]));
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() =>
        expect(outcomes).toEqual(["rejected:400", "resolved:false"]),
    );
});

it("saves one router's Model Selections under that router's profile field", async () => {
    function SaveSelections() {
        const { profile, updateRouterModels } = useUserProfile();
        if (!profile) return null;
        return (
            <>
                <span data-testid="foundry-models">
                    {profile.azureFoundryModels.join(",")}
                </span>
                <button
                    onClick={() =>
                        void updateRouterModels("azure-foundry", ["claude-opus-5-5"])
                    }
                >
                    Save selections
                </button>
            </>
        );
    }
    updateUserProfile.mockResolvedValue({
        ...apiProfile(false),
        azureFoundryModels: ["claude-opus-5-5"],
    });
    render(<UserProfileProvider><SaveSelections /></UserProfileProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Save selections" }));
    await waitFor(() =>
        expect(screen.getByTestId("foundry-models")).toHaveTextContent(
            "claude-opus-5-5",
        ),
    );
    expect(updateUserProfile).toHaveBeenCalledWith({
        azureFoundryModels: ["claude-opus-5-5"],
    });
});

describe("UserProfileProvider dark mode", () => {
    it("switches from dark to light and back to dark", async () => {
        render(
            <UserProfileProvider>
                <ThemeControls />
            </UserProfileProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("mode")).toHaveTextContent("dark");
            expect(document.documentElement).toHaveClass("dark");
        });

        fireEvent.click(screen.getByRole("button", { name: "Light" }));
        await waitFor(() => {
            expect(screen.getByTestId("mode")).toHaveTextContent("light");
            expect(document.documentElement).not.toHaveClass("dark");
        });

        fireEvent.click(screen.getByRole("button", { name: "Dark" }));
        await waitFor(() => {
            expect(screen.getByTestId("mode")).toHaveTextContent("dark");
            expect(document.documentElement).toHaveClass("dark");
        });

        expect(updateUserProfile).toHaveBeenNthCalledWith(1, {
            darkMode: false,
        });
        expect(updateUserProfile).toHaveBeenNthCalledWith(2, {
            darkMode: true,
        });
    });

    it("rolls the document theme back when persistence fails", async () => {
        updateUserProfile.mockRejectedValueOnce(new Error("save failed"));
        function FailingControl() {
            const { updateDarkMode } = useUserProfile();
            return (
                <button
                    onClick={() => {
                        void updateDarkMode(false).catch(() => {});
                    }}
                >
                    Light
                </button>
            );
        }
        render(
            <UserProfileProvider>
                <FailingControl />
            </UserProfileProvider>,
        );
        await waitFor(() =>
            expect(document.documentElement).toHaveClass("dark"),
        );

        fireEvent.click(screen.getByRole("button", { name: "Light" }));
        await waitFor(() =>
            expect(document.documentElement).toHaveClass("dark"),
        );
    });

    it("persists and updates the last-selected model immediately", async () => {
        render(
            <UserProfileProvider>
                <LastSelectedModel />
            </UserProfileProvider>,
        );
        await waitFor(() => expect(screen.getByText("none")).toBeVisible());

        fireEvent.click(screen.getByRole("button", { name: "Select model" }));

        await waitFor(() =>
            expect(screen.getByText("gpt-5.6-luna")).toBeVisible(),
        );
        expect(updateLastSelectedChatSettings).toHaveBeenCalledWith({
            lastSelectedChatModel: "gpt-5.6-luna",
        });
    });

    it("routes tabular chat selections to the nested chat resource", async () => {
        const settingsListener = vi.fn();
        const unsubscribe =
            subscribeToTabularChatSettingsUpdates(settingsListener);
        render(
            <UserProfileProvider>
                <TabularChatSettings />
            </UserProfileProvider>,
        );
        await waitFor(() => expect(getUserProfile).toHaveBeenCalled());

        fireEvent.click(
            screen.getByRole("button", { name: "Select tabular model" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Select tabular reasoning" }),
        );

        await waitFor(() => {
            expect(updateTabularChatModel).toHaveBeenCalledWith(
                "r1",
                "c1",
                "gpt-5.6-luna",
            );
            expect(updateTabularChatReasoningLevel).toHaveBeenCalledWith(
                "r1",
                "c1",
                "low",
            );
        });
        expect(updateChatModel).not.toHaveBeenCalled();
        expect(settingsListener).toHaveBeenCalledWith({
            reviewId: "r1",
            chatId: "c1",
            model: "gpt-5.6-luna",
        });
        expect(settingsListener).toHaveBeenCalledWith({
            reviewId: "r1",
            chatId: "c1",
            reasoningLevel: "low",
        });
        unsubscribe();
    });
});
