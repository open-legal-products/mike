import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
    getUserProfile,
    updateUserProfile,
    updateChatModel,
    updateTabularChatModel,
    updateTabularChatReasoningLevel,
    updateLastSelectedChatSettings,
    authState,
} = vi.hoisted(() => ({
    getUserProfile: vi.fn(),
    updateUserProfile: vi.fn(),
    updateChatModel: vi.fn(),
    updateTabularChatModel: vi.fn(),
    updateTabularChatReasoningLevel: vi.fn(),
    updateLastSelectedChatSettings: vi.fn(),
    authState: { current: { user: { id: "u1" } as { id: string } | null, isAuthenticated: true } },
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => authState.current,
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
    const { profile, persistChatModelSelection, reloadProfile, updateLegalResearchUs } = useUserProfile();
    return (
        <>
            <span>{profile?.lastSelectedChatModel ?? "none"}</span>
            <span data-testid="research">{String(profile?.legalResearchUs)}</span>
            <span data-testid="display-name">{profile?.displayName}</span>
            <button onClick={() => void reloadProfile()}>Reload profile</button>
            <button onClick={() => void updateLegalResearchUs(true)}>Enable research</button>
            <button
                onClick={() => void persistChatModelSelection("gpt-5.6-luna")}
            >
                Select model
            </button>
        </>
    );
}

function ProfileLoadState() {
    const { loading, apiKeysDegraded, profile, reloadProfile } = useUserProfile();
    return (
        <>
            <span data-testid="profile-state">
                {loading ? "loading" : apiKeysDegraded ? "degraded" : "ready"}
            </span>
            <span data-testid="profile-tier">{profile?.tier}</span>
            <button onClick={() => void reloadProfile()}>Reload profile</button>
        </>
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
    authState.current = { user: { id: "u1" }, isAuthenticated: true };
    delete window.mikeDesktop;
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
    delete window.mikeDesktop;
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    vi.clearAllMocks();
});

describe("UserProfileProvider desktop starter", () => {
    it.each(["initial load", "reload"])(
        "degrades a malformed profile on %s without crashing the provider",
        async (phase) => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const readyLocalModel = vi.fn(async () => null);
            window.mikeDesktop = { readyLocalModel };
            try {
                if (phase === "initial load") {
                    getUserProfile.mockResolvedValue({ models: [] });
                }
                render(<UserProfileProvider><ProfileLoadState /></UserProfileProvider>);
                if (phase === "reload") {
                    await waitFor(() => expect(screen.getByTestId("profile-state")).toHaveTextContent("ready"));
                    readyLocalModel.mockClear();
                    getUserProfile.mockResolvedValue({ models: [] });
                    fireEvent.click(screen.getByRole("button", { name: "Reload profile" }));
                }
                await waitFor(() => expect(screen.getByTestId("profile-state")).toHaveTextContent("degraded"));
                expect(screen.getByTestId("profile-tier")).toHaveTextContent("Free");
                expect(readyLocalModel).not.toHaveBeenCalled();
                expect(warn).toHaveBeenCalled();
            } finally {
                warn.mockRestore();
            }
        },
    );

    it("initializes an installed local model and disables online research", async () => {
        window.mikeDesktop = { readyLocalModel: async () => "ollama/qwen3.5:4b" };
        updateUserProfile.mockResolvedValue({ ...apiProfile(true), lastSelectedChatModel: "ollama/qwen3.5:4b", legalResearchUs: false });
        render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        expect(await screen.findByText("ollama/qwen3.5:4b")).toBeInTheDocument();
        expect(screen.getByTestId("research")).toHaveTextContent("false");
    });

    it("keeps an explicit selection made while runtime readiness is pending", async () => {
        let ready!: (model: string) => void;
        window.mikeDesktop = { readyLocalModel: () => new Promise((resolve) => { ready = resolve; }) };
        render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(ready).toBeTypeOf("function"));
        fireEvent.click(screen.getByRole("button", { name: "Select model" }));
        expect(await screen.findByText("gpt-5.6-luna")).toBeInTheDocument();
        await act(async () => { ready("ollama/qwen3.5:4b"); });
        expect(updateUserProfile).not.toHaveBeenCalled();
        expect(screen.getByText("gpt-5.6-luna")).toBeInTheDocument();
    });

    it("orders an explicit model write after an already-started starter write", async () => {
        let saved!: (value: Omit<ReturnType<typeof apiProfile>, "lastSelectedChatModel"> & { lastSelectedChatModel: string | null }) => void;
        window.mikeDesktop = { readyLocalModel: async () => "ollama/qwen3.5:4b" };
        updateUserProfile.mockImplementation(() => new Promise((resolve) => { saved = resolve; }));
        render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(saved).toBeTypeOf("function"));
        fireEvent.click(screen.getByRole("button", { name: "Select model" }));
        expect(updateLastSelectedChatSettings).not.toHaveBeenCalled();
        await act(async () => { saved({ ...apiProfile(true), lastSelectedChatModel: "ollama/qwen3.5:4b" }); });
        expect(await screen.findByText("gpt-5.6-luna")).toBeInTheDocument();
        expect(updateLastSelectedChatSettings).toHaveBeenCalledWith({ lastSelectedChatModel: "gpt-5.6-luna" });
    });

    it("does not replace a selected model with a stale profile reload", async () => {
        render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(screen.getByTestId("research")).toHaveTextContent("true"));
        let loaded!: (value: ReturnType<typeof apiProfile>) => void;
        getUserProfile.mockImplementationOnce(() => new Promise((resolve) => { loaded = resolve; }));
        fireEvent.click(screen.getByRole("button", { name: "Reload profile" }));
        fireEvent.click(screen.getByRole("button", { name: "Select model" }));
        expect(await screen.findByText("gpt-5.6-luna")).toBeInTheDocument();
        await act(async () => { loaded(apiProfile(true)); });
        expect(screen.getByText("gpt-5.6-luna")).toBeInTheDocument();
    });

    it("retains a selection that completes before the initial profile fetch", async () => {
        let loaded!: (value: ReturnType<typeof apiProfile>) => void;
        getUserProfile.mockImplementationOnce(() => new Promise((resolve) => { loaded = resolve; }));
        render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        fireEvent.click(screen.getByRole("button", { name: "Select model" }));
        expect(await screen.findByText("gpt-5.6-luna")).toBeInTheDocument();
        await act(async () => { loaded(apiProfile(true)); });
        expect(screen.getByText("gpt-5.6-luna")).toBeInTheDocument();
    });

    it("shares an in-flight starter write when another profile load begins", async () => {
        let saved!: (value: ReturnType<typeof apiProfile>) => void;
        window.mikeDesktop = { readyLocalModel: vi.fn(async () => "ollama/qwen3.5:4b") };
        updateUserProfile.mockImplementation(() => new Promise((resolve) => { saved = resolve; }));
        render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(saved).toBeTypeOf("function"));
        fireEvent.click(screen.getByRole("button", { name: "Reload profile" }));
        await waitFor(() => expect(window.mikeDesktop?.readyLocalModel).toHaveBeenCalledTimes(2));
        expect(updateUserProfile).toHaveBeenCalledTimes(1);
        await act(async () => { saved(apiProfile(true)); });
    });

    it("does not share a pending starter profile with a different signed-in account", async () => {
        let savedFirst!: (profile: ReturnType<typeof apiProfile>) => void;
        window.mikeDesktop = { readyLocalModel: async () => "ollama/qwen3.5:4b" };
        updateUserProfile.mockImplementationOnce(() => new Promise((resolve) => { savedFirst = resolve; }));
        const { rerender } = render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(savedFirst).toBeTypeOf("function"));

        authState.current = { user: { id: "u2" }, isAuthenticated: true };
        getUserProfile.mockResolvedValue({ ...apiProfile(false), displayName: "Bob" });
        updateUserProfile.mockResolvedValue({ ...apiProfile(false), displayName: "Bob", lastSelectedChatModel: "ollama/qwen3.5:4b", legalResearchUs: false });
        rerender(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(updateUserProfile).toHaveBeenCalledTimes(2));
        expect(await screen.findByText("ollama/qwen3.5:4b")).toBeInTheDocument();
        await act(async () => { savedFirst({ ...apiProfile(true), displayName: "Alice private profile" }); });
        expect(screen.getByTestId("display-name")).toHaveTextContent("Bob");
        expect(screen.getByTestId("research")).toHaveTextContent("false");
        expect(screen.getByText("ollama/qwen3.5:4b")).toBeInTheDocument();
    });

    it.each(["Select model", "Enable research"])("does not submit a queued %s action after the account changes", async (action) => {
        let savedFirst!: (profile: ReturnType<typeof apiProfile>) => void;
        window.mikeDesktop = { readyLocalModel: async () => "ollama/qwen3.5:4b" };
        updateUserProfile.mockImplementationOnce(() => new Promise((resolve) => { savedFirst = resolve; }));
        const { rerender } = render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(savedFirst).toBeTypeOf("function"));
        fireEvent.click(screen.getByRole("button", { name: action }));

        authState.current = { user: { id: "u2" }, isAuthenticated: true };
        getUserProfile.mockResolvedValue({ ...apiProfile(false), displayName: "Bob", lastSelectedChatModel: "gpt-existing", legalResearchUs: false });
        rerender(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        expect(await screen.findByText("gpt-existing")).toBeInTheDocument();
        await act(async () => { savedFirst(apiProfile(true)); });
        expect(updateLastSelectedChatSettings).not.toHaveBeenCalled();
        expect(updateUserProfile).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("display-name")).toHaveTextContent("Bob");
        expect(screen.getByText("gpt-existing")).toBeInTheDocument();
        expect(screen.getByTestId("research")).toHaveTextContent("false");
    });

    it.each(["Select model", "Enable research"])("discards an in-flight %s response after the account changes", async (action) => {
        let savedFirst!: (profile: ReturnType<typeof apiProfile>) => void;
        const mutation = action === "Select model" ? updateLastSelectedChatSettings : updateUserProfile;
        mutation.mockImplementationOnce(() => new Promise((resolve) => { savedFirst = resolve; }));
        const { rerender } = render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(screen.getByTestId("display-name")).toHaveTextContent("Ada"));
        fireEvent.click(screen.getByRole("button", { name: action }));
        await waitFor(() => expect(savedFirst).toBeTypeOf("function"));

        authState.current = { user: { id: "u2" }, isAuthenticated: true };
        getUserProfile.mockResolvedValue({ ...apiProfile(false), displayName: "Bob", lastSelectedChatModel: "gpt-existing", legalResearchUs: false });
        rerender(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        expect(await screen.findByText("gpt-existing")).toBeInTheDocument();
        await act(async () => { savedFirst(apiProfile(true)); });
        expect(screen.getByTestId("display-name")).toHaveTextContent("Bob");
        expect(screen.getByText("gpt-existing")).toBeInTheDocument();
        expect(screen.getByTestId("research")).toHaveTextContent("false");
    });

    it("does not save a runtime reply after the provider unmounts", async () => {
        let ready!: (model: string) => void;
        window.mikeDesktop = { readyLocalModel: () => new Promise((resolve) => { ready = resolve; }) };
        const { unmount } = render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(ready).toBeTypeOf("function"));
        unmount();
        await act(async () => { ready("ollama/qwen3.5:4b"); });
        expect(updateUserProfile).not.toHaveBeenCalled();
    });

    it("does not submit a queued model selection after the provider unmounts", async () => {
        let saved!: (profile: ReturnType<typeof apiProfile>) => void;
        window.mikeDesktop = { readyLocalModel: async () => "ollama/qwen3.5:4b" };
        updateUserProfile.mockImplementationOnce(() => new Promise((resolve) => { saved = resolve; }));
        const { unmount } = render(<UserProfileProvider><LastSelectedModel /></UserProfileProvider>);
        await waitFor(() => expect(saved).toBeTypeOf("function"));
        fireEvent.click(screen.getByRole("button", { name: "Select model" }));
        unmount();
        await act(async () => { saved(apiProfile(true)); });
        expect(updateLastSelectedChatSettings).not.toHaveBeenCalled();
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
