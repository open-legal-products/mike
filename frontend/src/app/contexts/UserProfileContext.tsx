"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useState,
    useRef,
    ReactNode,
    useCallback,
} from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    type ApiKeyState,
    type ApiKeyProvider,
    type PersonalisationDetails,
    type PracticeSetting,
    type ProfessionalTitle,
    type UserProfile as ApiUserProfile,
    completeUserOnboarding,
    getUserProfile,
    isMfaRequiredError,
    saveApiKey,
    syncUserPasswordSet,
    updateUserMfaOnLogin,
    updateUserProfile,
    updateChatModel,
    updateChatReasoningLevel,
    updateTabularChatModel,
    updateTabularChatReasoningLevel,
    updateLastSelectedChatSettings,
    parseTabularChatSelectionKey,
} from "@/app/lib/mikeApi";
import type { Message } from "@/app/components/shared/types";
import { applyDarkMode } from "@/app/lib/theme";
import { initializeDesktopLocalModel } from "@/app/lib/desktopLocalModel";
import { publishTabularChatSettingsUpdate } from "@/app/lib/tabularChatSettingsEvents";
import {
    clearConfiguredModels,
    refreshConfiguredModels,
} from "@/app/hooks/useConfiguredModels";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    jurisdiction: string | null;
    practiceSetting: PracticeSetting | null;
    professionalTitle: ProfessionalTitle | null;
    practiceAreas: string[];
    onboardingVersion: number | null;
    onboardingComplete: boolean;
    passwordSet: boolean;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string | null;
    tabularModel: string | null;
    memoryCuratorModel: string | null;
    lastSelectedChatModel: string | null;
    lastSelectedReasoningLevel: NonNullable<Message["reasoning"]>;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    quickActionsVisible: boolean;
    openRouterModels: string[];
    vercelModels: string[];
    openCodeGoModels: string[];
    darkMode: boolean;
    projectMemoryDefault: boolean;
    apiKeys: ApiKeyState;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    /**
     * True when the profile fetch failed (after a retry) and `profile` holds
     * the local fallback. Every field on it is a placeholder, not an answer:
     * apiKeys say "nothing configured" and the router model lists are empty
     * only because the truth is unknown. Consumers must distinguish this from
     * a real profile that loaded with the same values — key-gated UI fails
     * open, and destructive normalization (e.g. resetting a saved composer
     * selection that is absent from the router lists) must not run at all.
     */
    apiKeysDegraded: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    completeOnboarding: (details?: PersonalisationDetails) => Promise<boolean>;
    updatePersonalisation: (
        details: PersonalisationDetails,
    ) => Promise<boolean>;
    syncPasswordSet: () => Promise<boolean>;
    updateModelPreference: (
        field: "titleModel" | "tabularModel" | "memoryCuratorModel",
        value: string | null,
    ) => Promise<boolean>;
    persistChatModelSelection: (
        model: string,
        chatId?: string | null,
    ) => Promise<boolean>;
    persistChatReasoningSelection: (
        reasoningLevel: NonNullable<Message["reasoning"]>,
        chatId?: string | null,
    ) => Promise<boolean>;
    updateMfaOnLogin: (enabled: boolean) => Promise<boolean>;
    updateLegalResearchUs: (enabled: boolean) => Promise<boolean>;
    updateQuickActionsVisible: (visible: boolean) => Promise<boolean>;
    updateOpenRouterModels: (models: string[]) => Promise<boolean>;
    updateVercelModels: (models: string[]) => Promise<boolean>;
    updateOpenCodeGoModels: (models: string[]) => Promise<boolean>;
    updateDarkMode: (enabled: boolean) => Promise<void>;
    updateProjectMemoryDefault: (enabled: boolean) => Promise<void>;
    updateApiKey: (
        provider: ApiKeyProvider,
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const API_KEY_PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "openrouter",
    "vercel",
    "opencode-go",
    "courtlistener",
];

function emptyApiKeys(): ApiKeyState {
    return {
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        vercel: { configured: false, source: null },
        "opencode-go": { configured: false, source: null },
        courtlistener: { configured: false, source: null },
    };
}

function toProfile(data: ApiUserProfile): UserProfile {
    const { apiKeyStatus, ...profile } = data;
    const apiKeys = emptyApiKeys();
    for (const provider of API_KEY_PROVIDERS) {
        apiKeys[provider] = {
            configured: !!apiKeyStatus[provider],
            source:
                apiKeyStatus.sources?.[provider] ??
                (apiKeyStatus[provider] ? "user" : null),
        };
    }

    return {
        ...profile,
        jurisdiction: profile.jurisdiction ?? null,
        practiceSetting: profile.practiceSetting ?? null,
        professionalTitle: profile.professionalTitle ?? null,
        practiceAreas: Array.isArray(profile.practiceAreas)
            ? profile.practiceAreas
            : [],
        onboardingVersion: profile.onboardingVersion ?? null,
        onboardingComplete: profile.onboardingComplete !== false,
        passwordSet: profile.passwordSet === true,
        memoryCuratorModel: profile.memoryCuratorModel ?? null,
        lastSelectedChatModel: profile.lastSelectedChatModel ?? null,
        lastSelectedReasoningLevel:
            profile.lastSelectedReasoningLevel ?? "high",
        mfaOnLogin: profile.mfaOnLogin === true,
        projectMemoryDefault: profile.projectMemoryDefault !== false,
        openRouterModels: Array.isArray(profile.openRouterModels)
            ? profile.openRouterModels
            : [],
        vercelModels: Array.isArray(profile.vercelModels)
            ? profile.vercelModels
            : [],
        openCodeGoModels: Array.isArray(profile.openCodeGoModels)
            ? profile.openCodeGoModels
            : [],
        apiKeys,
    };
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [apiKeysDegraded, setApiKeysDegraded] = useState(false);
    const userId = user?.id ?? null;
    const authenticatedUserId = isAuthenticated ? userId : null;
    const authScope = useRef({ userId: authenticatedUserId });
    const loadRevision = useRef(0);
    const selectionRevision = useRef(0);
    const starterMutation = useRef<{
        scope: { userId: string | null };
        promise: Promise<ApiUserProfile>;
    } | null>(null);

    // A scope object identifies this authenticated session, including signing
    // out and back into the same account while an older request is pending.
    useLayoutEffect(() => {
        if (authScope.current.userId !== authenticatedUserId) {
            authScope.current = { userId: authenticatedUserId };
        }
        const scope = authScope.current;
        return () => {
            if (authScope.current === scope) authScope.current = { userId: null };
        };
    }, [authenticatedUserId]);

    const loadProfile = useCallback(async () => {
        const scope = authScope.current;
        if (!scope.userId) return;
        const revision = ++loadRevision.current;
        const initialSelectionRevision = selectionRevision.current;
        const isCurrentLoad = () =>
            scope === authScope.current && revision === loadRevision.current;
        const canInitializeStarter = () =>
            isCurrentLoad() && initialSelectionRevision === selectionRevision.current;
        try {
            let profileData: ApiUserProfile;
            try {
                profileData = await getUserProfile();
            } catch {
                // One retry with a short backoff absorbs a transient network
                // blip before the app falls back to the degraded profile.
                await new Promise((resolve) => setTimeout(resolve, 750));
                profileData = await getUserProfile();
            }
            if (!isCurrentLoad()) return;
            // Normalize while this try/catch owns errors. React can defer a
            // state updater until render, after this async function returns.
            const loaded = toProfile(profileData);
            setProfile((current) => {
                if (!canInitializeStarter() && current) {
                    return {
                        ...loaded,
                        lastSelectedChatModel: current.lastSelectedChatModel,
                        legalResearchUs: current.legalResearchUs,
                    };
                }
                return loaded;
            });
            setApiKeysDegraded(false);
            if (canInitializeStarter()) {
                const initialized = await initializeDesktopLocalModel(
                    profileData,
                    window.mikeDesktop,
                    async (selection) => {
                        const pending = starterMutation.current?.scope === scope
                            ? starterMutation.current
                            : { scope, promise: updateUserProfile(selection) };
                        starterMutation.current = pending;
                        try {
                            return await pending.promise;
                        } finally {
                            if (starterMutation.current === pending) starterMutation.current = null;
                        }
                    },
                    canInitializeStarter,
                );
                if (canInitializeStarter() && initialized !== profileData) {
                    setProfile(toProfile(initialized));
                }
            }
        } catch (error) {
            if (!isCurrentLoad()) return;
            console.warn(
                "[profile] fetch failed after retry; API key availability is unknown and fails open",
                error,
            );
            setApiKeysDegraded(true);
            // Calculate a default future reset date for fallback
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);

            // Set fallback profile data on exception
            setProfile({
                displayName: null,
                organisation: null,
                jurisdiction: null,
                practiceSetting: null,
                professionalTitle: null,
                practiceAreas: [],
                onboardingVersion: 0,
                onboardingComplete: true,
                passwordSet: false,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999, // temporarily unlimited
                tier: "Free",
                titleModel: null,
                tabularModel: null,
                memoryCuratorModel: null,
                lastSelectedChatModel: null,
                lastSelectedReasoningLevel: "high",
                mfaOnLogin: false,
                legalResearchUs: true,
                quickActionsVisible: true,
                openRouterModels: [],
                vercelModels: [],
                openCodeGoModels: [],
                darkMode: false,
                projectMemoryDefault: true,
                apiKeys: emptyApiKeys(),
            });
        } finally {
            if (isCurrentLoad()) setLoading(false);
        }
    }, []);

    // A new signed-in user invalidates the shared model catalog. This runs as
    // a LAYOUT effect on purpose: React runs a component's passive effects
    // only after its descendants' passive effects, so the model pickers that
    // mount in the same commit (ChatInput, ModelToggle) used to start their
    // own request first and this provider then force-discarded it and sent
    // a second one: /models/configured twice on every signed-in page load.
    // Layout effects all run before any passive effect, so the provider's
    // refresh now starts first and the pickers join its in-flight request.
    useLayoutEffect(() => {
        if (isAuthenticated && userId) {
            void refreshConfiguredModels();
        } else {
            clearConfiguredModels();
        }
    }, [isAuthenticated, userId]);

    useEffect(() => {
        if (isAuthenticated && userId) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
        return () => { loadRevision.current += 1; };
    }, [isAuthenticated, userId, loadProfile]);

    useEffect(() => {
        applyDarkMode(profile?.darkMode === true);
    }, [profile?.darkMode]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }

            try {
                const updated = await updateUserProfile({ displayName });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ organisation });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const completeOnboarding = useCallback(
        async (details: PersonalisationDetails = {}): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await completeUserOnboarding(details);
                setProfile(toProfile(updated));
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updatePersonalisation = useCallback(
        async (details: PersonalisationDetails): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile(details);
                setProfile(toProfile(updated));
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const syncPasswordSet = useCallback(async (): Promise<boolean> => {
        if (!user) return false;
        try {
            const updated = await syncUserPasswordSet();
            setProfile(toProfile(updated));
            return true;
        } catch {
            return false;
        }
    }, [user]);

    const updateModelPreference = useCallback(
        async (
            field: "titleModel" | "tabularModel" | "memoryCuratorModel",
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    [field]: value,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const persistChatModelSelection = useCallback(
        async (model: string, chatId?: string | null): Promise<boolean> => {
            const scope = authScope.current;
            if (!user || scope.userId !== user.id) return false;
            selectionRevision.current += 1;
            try {
                // If setup has already sent its initial PATCH, finish it
                // first so an explicit user choice is always the later write.
                if (starterMutation.current?.scope === scope) {
                    await starterMutation.current.promise.catch(() => undefined);
                }
                if (scope !== authScope.current) return false;
                let selectionProfile: ApiUserProfile | undefined;
                if (chatId) {
                    const tabularChat = parseTabularChatSelectionKey(chatId);
                    if (tabularChat) {
                        await updateTabularChatModel(
                            tabularChat.reviewId,
                            tabularChat.chatId,
                            model,
                        );
                        if (scope !== authScope.current) return false;
                        publishTabularChatSettingsUpdate({
                            reviewId: tabularChat.reviewId,
                            chatId: tabularChat.chatId,
                            model,
                        });
                    } else {
                        await updateChatModel(chatId, model);
                    }
                } else {
                    selectionProfile = await updateLastSelectedChatSettings({
                        lastSelectedChatModel: model,
                    });
                }
                if (scope !== authScope.current) return false;
                setProfile((current) => {
                    const selected = current ?? (selectionProfile ? toProfile(selectionProfile) : null);
                    return selected ? { ...selected, lastSelectedChatModel: model } : selected;
                });
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const persistChatReasoningSelection = useCallback(
        async (
            reasoningLevel: NonNullable<Message["reasoning"]>,
            chatId?: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            try {
                if (chatId) {
                    const tabularChat = parseTabularChatSelectionKey(chatId);
                    if (tabularChat) {
                        await updateTabularChatReasoningLevel(
                            tabularChat.reviewId,
                            tabularChat.chatId,
                            reasoningLevel,
                        );
                        publishTabularChatSettingsUpdate({
                            reviewId: tabularChat.reviewId,
                            chatId: tabularChat.chatId,
                            reasoningLevel,
                        });
                    } else {
                        await updateChatReasoningLevel(chatId, reasoningLevel);
                    }
                } else {
                    await updateLastSelectedChatSettings({
                        lastSelectedReasoningLevel: reasoningLevel,
                    });
                }
                setProfile((current) =>
                    current
                        ? {
                              ...current,
                              lastSelectedReasoningLevel: reasoningLevel,
                          }
                        : current,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateMfaOnLogin = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserMfaOnLogin(enabled);
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const updateLegalResearchUs = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            const scope = authScope.current;
            if (!user || scope.userId !== user.id) return false;
            selectionRevision.current += 1;
            try {
                if (starterMutation.current?.scope === scope) {
                    await starterMutation.current.promise.catch(() => undefined);
                }
                if (scope !== authScope.current) return false;
                const updated = await updateUserProfile({
                    legalResearchUs: enabled,
                });
                if (scope !== authScope.current) return false;
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateQuickActionsVisible = useCallback(
        async (visible: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    quickActionsVisible: visible,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOpenRouterModels = useCallback(
        async (openRouterModels: string[]): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ openRouterModels });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateVercelModels = useCallback(
        async (vercelModels: string[]): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ vercelModels });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOpenCodeGoModels = useCallback(
        async (openCodeGoModels: string[]): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ openCodeGoModels });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateDarkMode = useCallback(
        async (enabled: boolean): Promise<void> => {
            if (!user) throw new Error("Sign in to update Dark Mode.");
            const previous = profile?.darkMode === true;
            applyDarkMode(enabled);
            try {
                const updated = await updateUserProfile({ darkMode: enabled });
                const normalized = toProfile(updated);
                setProfile((prev) =>
                    prev ? { ...prev, ...normalized, darkMode: enabled } : null,
                );
            } catch (error) {
                applyDarkMode(previous);
                throw error;
            }
        },
        [user, profile?.darkMode],
    );

    const updateProjectMemoryDefault = useCallback(
        async (enabled: boolean): Promise<void> => {
            if (!user) {
                throw new Error("Sign in to update memory settings.");
            }
            const updated = await updateUserProfile({
                projectMemoryDefault: enabled,
            });
            const normalized = toProfile(updated);
            setProfile((prev) =>
                prev
                    ? { ...prev, ...normalized, projectMemoryDefault: enabled }
                    : null,
            );
        },
        [user],
    );

    const updateApiKey = useCallback(
        async (
            provider: ApiKeyProvider,
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const normalized = value?.trim() ? value.trim() : null;
            try {
                const status = await saveApiKey(provider, normalized);
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              apiKeys: {
                                  ...prev.apiKeys,
                                  [provider]: {
                                      configured: status[provider],
                                      source:
                                          status.sources?.[provider] ?? null,
                                  },
                              },
                          }
                        : null,
                );
                void refreshConfiguredModels();
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (userId) {
            await loadProfile();
        }
    }, [userId, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) {
            return false;
        }

        // Check if user has credits remaining
        if (profile.creditsRemaining <= 0) {
            return false;
        }

        return false;
    }, [user, profile]);

    // A fresh object here re-renders every consumer of this context on every
    // provider render, profile change or not.
    const value = useMemo<UserProfileContextType>(
        () => ({
            profile,
            loading,
            apiKeysDegraded,
            updateDisplayName,
            updateOrganisation,
            completeOnboarding,
            updatePersonalisation,
            syncPasswordSet,
            updateModelPreference,
            persistChatModelSelection,
            persistChatReasoningSelection,
            updateMfaOnLogin,
            updateLegalResearchUs,
            updateQuickActionsVisible,
            updateOpenRouterModels,
            updateVercelModels,
            updateOpenCodeGoModels,
            updateDarkMode,
            updateProjectMemoryDefault,
            updateApiKey,
            reloadProfile,
            incrementMessageCredits,
        }),
        [
            profile,
            loading,
            apiKeysDegraded,
            updateDisplayName,
            updateOrganisation,
            completeOnboarding,
            updatePersonalisation,
            syncPasswordSet,
            updateModelPreference,
            persistChatModelSelection,
            persistChatReasoningSelection,
            updateMfaOnLogin,
            updateLegalResearchUs,
            updateQuickActionsVisible,
            updateOpenRouterModels,
            updateVercelModels,
            updateOpenCodeGoModels,
            updateDarkMode,
            updateProjectMemoryDefault,
            updateApiKey,
            reloadProfile,
            incrementMessageCredits,
        ],
    );

    return (
        <UserProfileContext.Provider value={value}>
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
