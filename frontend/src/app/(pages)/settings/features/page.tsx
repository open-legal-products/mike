"use client";

import { useEffect, useState } from "react";
import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
  createMcpConnector,
  isMfaRequiredError,
  listMcpConnectors,
  MikeApiError,
  refreshMcpConnectorTools,
  updateMcpConnector,
} from "@/app/lib/mikeApi";
import type { McpConnectorSummary } from "@/app/lib/mikeApi";
import {
  isLegalDataHunterConnector,
  LEGAL_DATA_HUNTER_MCP,
} from "@/app/lib/legalDataHunterConnector";
import {
  authorizeMcpConnector,
  openMcpOAuthPopup,
} from "@/app/lib/mcpOAuthPopup";

function isOAuthRequired(error: unknown): boolean {
  return (
    error instanceof MikeApiError &&
    error.status === 401 &&
    error.code === "oauth_required"
  );
}

async function listLegalDataHunterConnectors(): Promise<McpConnectorSummary[]> {
  return (await listMcpConnectors()).filter(isLegalDataHunterConnector);
}

function preferredLegalDataHunterConnector(
  connectors: readonly McpConnectorSummary[],
): McpConnectorSummary | null {
  return (
    [...connectors].sort(
      (left, right) =>
        Number(right.oauthConnected) - Number(left.oauthConnected) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )[0] ?? null
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
    void listLegalDataHunterConnectors()
      .then((connectors) => {
        if (cancelled) return;
        setLegalDataHunterConnectors(connectors);
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
    const oauthPopup = enabled ? openMcpOAuthPopup() : null;
    setLegalDataHunterError(null);
    setSavingLegalDataHunter(true);
    let rollbackConnectorId: string | null = null;
    try {
      if (await needsMfaVerification()) {
        oauthPopup?.close();
        setPendingLegalDataHunterEnabled(enabled);
        return;
      }
      let connectors = await listLegalDataHunterConnectors();
      setLegalDataHunterConnectors(connectors);
      if (!enabled) {
        const results = await Promise.allSettled(
          connectors
            .filter((candidate) => candidate.enabled)
            .map((candidate) =>
              updateMcpConnector(candidate.id, { enabled: false }),
            ),
        );
        setLegalDataHunterConnectors(await listLegalDataHunterConnectors());
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure) throw failure.reason;
        return;
      }

      let activeConnector = preferredLegalDataHunterConnector(connectors);
      if (!activeConnector) {
        const created = await createMcpConnector(LEGAL_DATA_HUNTER_MCP);
        connectors = await listLegalDataHunterConnectors();
        if (!connectors.some((candidate) => candidate.id === created.id)) {
          connectors = [...connectors, created];
        }
        activeConnector = preferredLegalDataHunterConnector(connectors);
      }
      if (!activeConnector) {
        throw new Error("Legal Data Hunter connector was not created.");
      }
      rollbackConnectorId = activeConnector.enabled ? activeConnector.id : null;
      setLegalDataHunterConnectors(connectors);

      let refreshed: McpConnectorSummary;
      try {
        refreshed = await refreshMcpConnectorTools(activeConnector.id);
      } catch (error) {
        if (!isOAuthRequired(error)) throw error;
        const result = await authorizeMcpConnector(
          activeConnector.id,
          oauthPopup,
        );
        if (result === "redirecting") return;
        refreshed = await refreshMcpConnectorTools(activeConnector.id);
      }
      oauthPopup?.close();

      const enabledConnector = refreshed.enabled
        ? refreshed
        : await updateMcpConnector(refreshed.id, { enabled: true });
      rollbackConnectorId = null;

      connectors = await listLegalDataHunterConnectors();
      const duplicateResults = await Promise.allSettled(
        connectors
          .filter(
            (candidate) =>
              candidate.id !== enabledConnector.id && candidate.enabled,
          )
          .map((candidate) =>
            updateMcpConnector(candidate.id, { enabled: false }),
          ),
      );
      setLegalDataHunterConnectors(await listLegalDataHunterConnectors());
      const duplicateFailure = duplicateResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (duplicateFailure) throw duplicateFailure.reason;
    } catch (error) {
      oauthPopup?.close();
      if (isMfaRequiredError(error)) {
        setPendingLegalDataHunterEnabled(enabled);
        return;
      }
      if (rollbackConnectorId) {
        try {
          await updateMcpConnector(rollbackConnectorId, { enabled: false });
        } catch {
          // The inventory reload below remains the source of truth.
        }
      }
      try {
        setLegalDataHunterConnectors(await listLegalDataHunterConnectors());
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
        <SettingsHeading>Assistant</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Quick actions</SettingsLabel>
              <SettingsDescription>
                Show the quick actions row on the assistant start screen.
              </SettingsDescription>
              {quickActionsError && (
                <p className="text-sm text-red-600" role="alert">
                  {quickActionsError}
                </p>
              )}
            </div>
            <ToggleSwitch
              checked={quickActionsVisible}
              disabled={savingQuickActions}
              aria-busy={savingQuickActions}
              aria-label="Quick actions"
              onCheckedChange={(checked) => {
                void setQuickActionsVisible(checked);
              }}
            />
          </SettingsRow>
        </SettingsCard>
      </section>

      <section className="space-y-3">
        <SettingsHeading>Legal Research</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Enable CourtListener</SettingsLabel>
              <SettingsDescription>
                CourtListener provides access to US case law.
              </SettingsDescription>
              {saveError && (
                <p className="text-sm text-red-600" role="alert">
                  {saveError}
                </p>
              )}
            </div>
            <ToggleSwitch
              checked={courtListenerEnabled}
              disabled={saving}
              aria-busy={saving}
              aria-label="Enable CourtListener"
              onCheckedChange={(enabled) =>
                void handleCourtListenerChange(enabled)
              }
            />
          </SettingsRow>
          {courtListenerEnabled && (
            <ApiKeyField
              label="CourtListener API Key"
              placeholder="Token..."
              hasSavedKey={!!profile?.apiKeys.courtlistener.configured}
              onSave={(value) =>
                updateApiKey("courtlistener", value.trim() || null)
              }
              onRemove={() => updateApiKey("courtlistener", null)}
            />
          )}
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Enable Legal Data Hunter</SettingsLabel>
              <SettingsDescription>
                Legal Data Hunter provides access to global case law and
                legislation.
              </SettingsDescription>
              {legalDataHunterError && (
                <p className="text-sm text-red-600" role="alert">
                  {legalDataHunterError}
                </p>
              )}
            </div>
            <ToggleSwitch
              checked={legalDataHunterEnabled}
              disabled={
                loadingLegalDataHunter ||
                !loadedLegalDataHunter ||
                savingLegalDataHunter
              }
              aria-busy={savingLegalDataHunter}
              aria-label="Enable Legal Data Hunter"
              onCheckedChange={(enabled) =>
                void handleLegalDataHunterChange(enabled)
              }
            />
          </SettingsRow>
        </SettingsCard>
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
