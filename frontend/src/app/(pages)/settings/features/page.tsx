"use client";

import { useEffect, useState } from "react";
import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    ensureLegalDataHunterConnector,
    isMfaRequiredError,
    listMcpConnectors,
    MikeApiError,
    refreshMcpConnectorTools,
    updateMcpConnector,
} from "@/app/lib/mikeApi";
import type { McpConnectorSummary } from "@/app/lib/mikeApi";
import { isLegalDataHunterConnector } from "@/app/lib/legalDataHunterConnector";
import { authorizeMcpConnector } from "@/app/lib/mcpOAuthPopup";
import { SettingsSection } from "../SettingsSection";
import { SettingsToggle } from "../SettingsToggle";

function isOAuthRequired(error: unknown): boolean {
    return (
        error instanceof MikeApiError &&
        error.status === 401 &&
        error.code === "oauth_required"
    );
}

export default function FeaturesPage() {
    const {
        profile,
        updateApiKey,
        updateLegalResearchUs,
        updateQuickActionsVisible,
    } = useUserProfile();
    const [quickActionsError, setQuickActionsError] = useState<string | null>(
        null,
    );
    const [saving, setSaving] = useState(false);
    const [savingQuickActions, setSavingQuickActions] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [optimisticLegalResearchUs, setOptimisticLegalResearchUs] = useState<
        boolean | null
    >(null);
    const [legalDataHunterConnectors, setLegalDataHunterConnectors] = useState<
        McpConnectorSummary[]
    >([]);
    const [loadingLegalDataHunter, setLoadingLegalDataHunter] = useState(true);
    const [loadedLegalDataHunter, setLoadedLegalDataHunter] = useState(false);
    const [savingLegalDataHunter, setSavingLegalDataHunter] = useState(false);
    const [legalDataHunterError, setLegalDataHunterError] = useState<
        string | null
    >(null);
    const [pendingLegalDataHunterEnabled, setPendingLegalDataHunterEnabled] =
        useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;
        void listMcpConnectors()
            .then((connectors) => {
                if (cancelled) return;
                setLegalDataHunterConnectors(
                    connectors.filter(isLegalDataHunterConnector),
                );
                setLoadedLegalDataHunter(true);
            })
            .catch(() => {
                if (!cancelled) {
                    setLegalDataHunterError(
                        "Could not load the Legal Data Hunter setting.",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoadingLegalDataHunter(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const persistedLegalResearchUs = profile?.legalResearchUs ?? true;
    const courtListenerEnabled =
        optimisticLegalResearchUs ?? persistedLegalResearchUs;
    const quickActionsVisible = profile?.quickActionsVisible ?? true;
    const legalDataHunterEnabled = legalDataHunterConnectors.some(
        (connector) => connector.enabled && connector.oauthConnected,
    );

    const setQuickActionsVisible = async (visible: boolean) => {
        setQuickActionsError(null);
        setSavingQuickActions(true);
        const ok = await updateQuickActionsVisible(visible);
        setSavingQuickActions(false);
        if (!ok) setQuickActionsError("Could not update. Try again.");
    };

    const handleCourtListenerChange = async (enabled: boolean) => {
        if (saving) return;
        setSaveError(null);
        setOptimisticLegalResearchUs(enabled);
        setSaving(true);
        const ok = await updateLegalResearchUs(enabled);
        setSaving(false);
        setOptimisticLegalResearchUs(null);
        if (!ok) {
            setSaveError("Could not update. Try again.");
        }
    };

    const handleLegalDataHunterChange = async (enabled: boolean) => {
        if (savingLegalDataHunter || !loadedLegalDataHunter) return;
        setLegalDataHunterError(null);
        setSavingLegalDataHunter(true);
        let connector: McpConnectorSummary | null = null;
        try {
            if (await needsMfaVerification()) {
                setPendingLegalDataHunterEnabled(enabled);
                return;
            }
            if (!enabled) {
                const enabledConnectors = legalDataHunterConnectors.filter(
                    (candidate) => candidate.enabled,
                );
                const disabledConnectors = await Promise.all(
                    enabledConnectors.map((candidate) =>
                        updateMcpConnector(candidate.id, { enabled: false }),
                    ),
                );
                const disabledById = new Map(
                    disabledConnectors.map((candidate) => [
                        candidate.id,
                        candidate,
                    ]),
                );
                setLegalDataHunterConnectors((current) =>
                    current.map(
                        (candidate) =>
                            disabledById.get(candidate.id) ?? candidate,
                    ),
                );
                return;
            }

            connector = await ensureLegalDataHunterConnector();
            setLegalDataHunterConnectors([connector]);

            let refreshed: McpConnectorSummary;
            try {
                refreshed = await refreshMcpConnectorTools(connector.id);
            } catch (error) {
                if (!isOAuthRequired(error)) throw error;
                const result = await authorizeMcpConnector(connector.id);
                if (result === "redirecting") return;
                refreshed = await refreshMcpConnectorTools(connector.id);
            }

            const enabledConnector = refreshed.enabled
                ? refreshed
                : await updateMcpConnector(refreshed.id, { enabled: true });
            setLegalDataHunterConnectors([enabledConnector]);
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingLegalDataHunterEnabled(enabled);
                return;
            }
            if (connector?.enabled) {
                try {
                    await updateMcpConnector(connector.id, { enabled: false });
                } catch {
                    // The inventory reload below remains the source of truth.
                }
            }
            try {
                const connectors = await listMcpConnectors();
                setLegalDataHunterConnectors(
                    connectors.filter(isLegalDataHunterConnector),
                );
            } catch {
                // Keep the last known state and surface the original failure.
            }
            setLegalDataHunterError(
                "Could not update the Legal Data Hunter setting.",
            );
        } finally {
            setSavingLegalDataHunter(false);
        }
    };

    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Assistant
                    </h2>
                </div>
                <SettingsSection>
                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-700">
                                Quick actions
                            </p>
                            <p className="text-sm text-gray-500">
                                Show the quick actions row on the assistant
                                start screen.
                            </p>
                            {quickActionsError && (
                                <p className="text-sm text-red-600">
                                    {quickActionsError}
                                </p>
                            )}
                        </div>
                        <SettingsToggle
                            checked={quickActionsVisible}
                            loading={savingQuickActions}
                            size="md"
                            onChange={(checked) => {
                                void setQuickActionsVisible(checked);
                            }}
                        />
                    </div>
                </SettingsSection>
            </section>

            <section className="space-y-3">
                <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        Legal Research
                    </h2>
                </div>
                <SettingsSection>
                    <div className="flex items-center justify-between gap-3 px-4 py-5">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-700">
                                Enable CourtListener
                            </p>
                            <p className="text-sm text-gray-500">
                                CourtListener provides access to US case law.
                            </p>
                        </div>
                        <SettingsToggle
                            checked={courtListenerEnabled}
                            loading={saving}
                            size="md"
                            onChange={(enabled) =>
                                void handleCourtListenerChange(enabled)
                            }
                        />
                    </div>
                    {saveError && (
                        <p className="px-4 pb-4 text-sm text-red-600">
                            {saveError}
                        </p>
                    )}
                    {courtListenerEnabled && (
                        <ApiKeyField
                            label="CourtListener API Key"
                            placeholder="Token..."
                            hasSavedKey={
                                !!profile?.apiKeys.courtlistener.configured
                            }
                            onSave={(value) =>
                                updateApiKey(
                                    "courtlistener",
                                    value.trim() || null,
                                )
                            }
                            onRemove={() => updateApiKey("courtlistener", null)}
                        />
                    )}
                    <div className="border-t border-gray-200/70 px-4 py-5">
                        <div className="flex items-center justify-between gap-3">
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-700">
                                    Enable Legal Data Hunter
                                </p>
                                <p className="text-sm text-gray-500">
                                    Legal Data Hunter provides access to global
                                    case law and legislation.
                                </p>
                            </div>
                            <SettingsToggle
                                ariaLabel="Enable Legal Data Hunter"
                                checked={legalDataHunterEnabled}
                                disabled={
                                    loadingLegalDataHunter ||
                                    !loadedLegalDataHunter
                                }
                                loading={savingLegalDataHunter}
                                size="md"
                                onChange={(enabled) =>
                                    void handleLegalDataHunterChange(enabled)
                                }
                            />
                        </div>
                        {legalDataHunterError && (
                            <p
                                role="alert"
                                className="mt-3 text-sm text-red-600"
                            >
                                {legalDataHunterError}
                            </p>
                        )}
                    </div>
                </SettingsSection>
            </section>
            <MfaVerificationPopup
                open={pendingLegalDataHunterEnabled !== null}
                onCancel={() => setPendingLegalDataHunterEnabled(null)}
                onVerified={() => {
                    const enabled = pendingLegalDataHunterEnabled;
                    setPendingLegalDataHunterEnabled(null);
                    if (enabled !== null) {
                        void handleLegalDataHunterChange(enabled);
                    }
                }}
                title="Verify to update Legal Data Hunter"
            />
        </div>
    );
}
