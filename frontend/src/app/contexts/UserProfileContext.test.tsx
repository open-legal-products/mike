import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

const {
    getUserProfile,
    updateUserProfile,
    updateChatModel,
    updateTabularChatModel,
    updateTabularChatReasoningLevel,
    updateLastSelectedChatSettings,
} = vi.hoisted(() => ({
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
}));

import { UserProfileProvider, useUserProfile } from "./UserProfileContext";
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

function DisplayNameControl() {
    const { updateDisplayName } = useUserProfile();
    return (
        <button onClick={() => void updateDisplayName("Ada Lovelace")}>
            Save name
        </button>
    );
}

function ModelPreferenceControl() {
    const { updateModelPreference } = useUserProfile();
    return (
        <button
            onClick={() =>
                void updateModelPreference("titleModel", "gpt-5.6-luna")
            }
        >
            Save model preference
        </button>
    );
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
    clearToasts();
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
    clearToasts();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    vi.clearAllMocks();
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

describe("UserProfileProvider failure reporting", () => {
    it("says why a profile save failed and offers a Retry that re-runs it", async () => {
        // Every mutator used to swallow its error and return `false`, so a
        // save that never happened looked identical to one that did.
        updateUserProfile.mockRejectedValueOnce(
            Object.assign(new Error("Internal error"), { status: 500 }),
        );
        render(
            <UserProfileProvider>
                <DisplayNameControl />
                <ToastViewportUI />
            </UserProfileProvider>,
        );
        await waitFor(() => expect(getUserProfile).toHaveBeenCalled());

        fireEvent.click(screen.getByRole("button", { name: "Save name" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't save your name");
        expect(alert).toHaveTextContent(
            "Something went wrong on our side. Try again.",
        );

        // Retry re-runs the same mutation with the same argument.
        updateUserProfile.mockClear();
        fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
        await waitFor(() =>
            expect(updateUserProfile).toHaveBeenCalledWith({
                displayName: "Ada Lovelace",
            }),
        );
    });

    it("reports a model preference that was not saved", async () => {
        // The model preferences page had no failure path of its own: the
        // dropdown snapped back with no explanation.
        updateUserProfile.mockRejectedValueOnce(
            Object.assign(new Error("Internal error"), { status: 500 }),
        );
        render(
            <UserProfileProvider>
                <ModelPreferenceControl />
                <ToastViewportUI />
            </UserProfileProvider>,
        );
        await waitFor(() => expect(getUserProfile).toHaveBeenCalled());

        fireEvent.click(
            screen.getByRole("button", { name: "Save model preference" }),
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't save your model preference");

        updateUserProfile.mockClear();
        fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
        await waitFor(() =>
            expect(updateUserProfile).toHaveBeenCalledWith({
                titleModel: "gpt-5.6-luna",
            }),
        );
    });

    it("reports a chat model selection that was not persisted", async () => {
        updateLastSelectedChatSettings.mockRejectedValueOnce(
            new TypeError("Failed to fetch"),
        );
        render(
            <UserProfileProvider>
                <LastSelectedModel />
                <ToastViewportUI />
            </UserProfileProvider>,
        );
        await waitFor(() => expect(screen.getByText("none")).toBeVisible());

        fireEvent.click(screen.getByRole("button", { name: "Select model" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't save your model selection");
    });

    it("says the profile could not be loaded instead of showing the fallback silently", async () => {
        // Both the first call and its one retry fail.
        getUserProfile.mockRejectedValue(new TypeError("Failed to fetch"));
        render(
            <UserProfileProvider>
                <DisplayNameControl />
                <ToastViewportUI />
            </UserProfileProvider>,
        );

        const alert = await screen.findByRole("alert", {}, { timeout: 4000 });
        expect(alert).toHaveTextContent("Couldn't load your profile");
    });
});
