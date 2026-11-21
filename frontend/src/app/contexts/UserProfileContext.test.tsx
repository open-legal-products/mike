import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@mike/ui";

const {
    setUserProfilePhoto,
    getUserProfile,
    updateUserProfile,
    updateChatModel,
    updateTabularChatModel,
    updateTabularChatReasoningLevel,
    updateLastSelectedChatSettings,
    saveApiKey,
} = vi.hoisted(() => ({
    saveApiKey: vi.fn(),
    setUserProfilePhoto: vi.fn(),
    getUserProfile: vi.fn(),
    updateUserProfile: vi.fn(),
    updateChatModel: vi.fn(),
    updateTabularChatModel: vi.fn(),
    updateTabularChatReasoningLevel: vi.fn(),
    updateLastSelectedChatSettings: vi.fn(),
}));

const reportError = vi.hoisted(() => vi.fn(() => null));
vi.mock("@/app/lib/errorReporting", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/errorReporting")>()),
    reportError,
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "u1" },
        isAuthenticated: true,
    }),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    setUserProfilePhoto: (...args: unknown[]) => setUserProfilePhoto(...args),
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

vi.mock("@/app/hooks/useOllamaModels", () => ({ useOllamaModels: () => [] }));
vi.mock("@/app/hooks/useConfiguredModels", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/hooks/useConfiguredModels")>()),
    useConfiguredModels: () => [],
}));

import { useState } from "react";
import { UserProfileProvider, useUserProfile } from "./UserProfileContext";
import { useModelApiKeys } from "@/app/hooks/useModelApiKeys";
import { ModelToggle } from "@/app/components/assistant/ModelToggle";
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
        subagentModel: null,
        subagentReasoning: null,
        lastSelectedChatModel: null,
        lastSelectedReasoningLevel: "high",
        mfaOnLogin: false,
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


it("updates every profile consumer immediately after saving or removing a photo", async () => {
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    getUserProfile.mockResolvedValue(apiProfile(false));
    setUserProfilePhoto.mockImplementation(async (value: string | null) => ({ profilePhoto: value }));
    function PhotoControls() {
        const { profile, updateProfilePhoto } = useUserProfile();
        return <>
            <span data-testid="photo-value">{profile?.profilePhoto ?? "none"}</span>
            <button onClick={() => void updateProfilePhoto(photo)}>Upload</button>
            <button onClick={() => void updateProfilePhoto(null)}>Remove photo</button>
        </>;
    }
    render(<UserProfileProvider><PhotoControls /></UserProfileProvider>);
    await waitFor(() => expect(getUserProfile).toHaveBeenCalled());
    fireEvent.click(screen.getByText("Upload"));
    await waitFor(() => expect(screen.getByTestId("photo-value")).toHaveTextContent(photo));
    fireEvent.click(screen.getByText("Remove photo"));
    await waitFor(() => expect(screen.getByTestId("photo-value")).toHaveTextContent("none"));
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

function ProfileSummary() {
    const { profile, loading, apiKeysDegraded, reloadProfile, updateDisplayName } = useUserProfile();
    const apiKeys = useModelApiKeys();
    const [saved, setSaved] = useState<string>("");
    if (loading) return null;
    return (
        <>
            <span data-testid="loaded">yes</span>
            <span data-testid="name">{profile?.displayName ?? "none"}</span>
            <span data-testid="degraded">{String(apiKeysDegraded)}</span>
            <span data-testid="keys">{apiKeys === undefined ? "unknown" : "known"}</span>
            <span data-testid="saved">{saved}</span>
            <button type="button" onClick={() => void reloadProfile()}>reload</button>
            <button
                type="button"
                onClick={() => void updateDisplayName("Grace").then((ok) => setSaved(String(ok)))}
            >
                rename
            </button>
            <ModelToggle value="gemini-3.8-flash" onChange={() => {}} apiKeys={apiKeys} />
        </>
    );
}

describe("UserProfileProvider when the server omits apiKeyStatus", () => {
    // Sentry MIKE-FRONTEND-4H: a profile answered 200 without
    // `apiKeyStatus`; normalising it threw, the throw was filed as a fault
    // and the user got the placeholder profile. Every Mike backend sends the
    // field, so the sender was a forked server or a proxy/misroute.
    const withoutKeyStatus = () => {
        const body: Partial<ReturnType<typeof apiProfile>> = apiProfile(false);
        delete body.apiKeyStatus;
        return body;
    };
    const renderProfile = () =>
        render(
            <UserProfileProvider>
                <ProfileSummary />
                <ToastViewportUI />
            </UserProfileProvider>,
        );
    const missingKeyStatusWarning = [
        expect.objectContaining({ message: "profile missing apiKeyStatus" }),
        {
            level: "warning",
            tags: { component: "profile", error_kind: "missing_api_key_status" },
        },
    ];

    it.each([
        ["missing", withoutKeyStatus],
        ["malformed", () => ({ ...apiProfile(false), apiKeyStatus: "enabled" })],
    ])("shows the real profile when the key status is %s, fails open and warns Sentry once", async (_case, body) => {
        getUserProfile.mockResolvedValue(body());
        renderProfile();

        await screen.findByTestId("loaded");
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByTestId("name")).toHaveTextContent("Ada");
        // Pickers fail open, as after a failed fetch: a server that omits
        // the status cannot vouch for which providers have keys.
        expect(screen.getByTestId("degraded")).toHaveTextContent("true");
        expect(getUserProfile).toHaveBeenCalledTimes(1);
        // One warning, no payload: the error is fixed text and the context
        // carries only the level and two static tags.
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenCalledWith(...missingKeyStatusWarning);

        // A reload on the same page does not report it again.
        fireEvent.click(screen.getByRole("button", { name: "reload" }));
        await waitFor(() => expect(getUserProfile).toHaveBeenCalledTimes(2));
        expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("leaves key state unknown, so the model picker offers models instead of No Models", async () => {
        getUserProfile.mockResolvedValue(withoutKeyStatus());
        renderProfile();

        await screen.findByTestId("loaded");
        expect(screen.getByTestId("keys")).toHaveTextContent("unknown");
        expect(screen.queryByText("No Models")).toBeNull();
        expect(screen.getByText("Gemini 3.8 Flash")).toBeInTheDocument();
    });

    it.each([true, false])("updates key availability when a save changes it (initially known: %s)", async (known) => {
        getUserProfile.mockResolvedValue(known ? apiProfile(false) : withoutKeyStatus());
        updateUserProfile.mockResolvedValue({
            ...(known ? withoutKeyStatus() : apiProfile(false)), displayName: "Grace",
        });
        renderProfile();
        await screen.findByTestId("loaded");
        expect(screen.getByTestId("keys")).toHaveTextContent(known ? "known" : "unknown");
        fireEvent.click(screen.getByRole("button", { name: "rename" }));
        await waitFor(() => expect(screen.getByTestId("saved")).toHaveTextContent("true"));
        expect(screen.getByTestId("keys")).toHaveTextContent(known ? "unknown" : "known");
        expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("applies a save whose response also lacks the key status, without a notice", async () => {
        getUserProfile.mockResolvedValue(withoutKeyStatus());
        updateUserProfile.mockResolvedValue({ ...withoutKeyStatus(), displayName: "Grace" });
        renderProfile();

        await screen.findByTestId("loaded");
        fireEvent.click(screen.getByRole("button", { name: "rename" }));

        await waitFor(() => expect(screen.getByTestId("saved")).toHaveTextContent("true"));
        expect(screen.getByTestId("name")).toHaveTextContent("Grace");
        expect(screen.getByTestId("keys")).toHaveTextContent("unknown");
        expect(screen.queryByRole("alert")).toBeNull();
        // Only the load's warning; the save is not reported as a failure.
        expect(reportError).toHaveBeenCalledTimes(1);
    });
});
