"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ByokProviderModal } from "@/app/components/settings/ByokProviderModal";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import {
  MODEL_API_KEY_FIELDS,
  ModelProviderIcon,
  type ModelApiKeyField,
} from "@/app/components/settings/modelProviders";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { routerSelectionsFromLists } from "@/app/hooks/useModelRouterSelections";
import {
  MikeApiError,
  getOrgApiKeys,
  isMfaRequiredError,
  saveOrgApiKey,
  saveOrgRouterModels,
  setOrgApiKeyEnabled,
  setOrgPersonalApiKeysAllowed,
  type ApiKeyProvider,
  type ApiKeySettings,
  type OrgApiKeySettings,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { RouterSlug } from "@/shared/lib/modelCatalog";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";

// An organization's model providers: the keys its work runs on, the models
// each may run, and whether a member's own key may stand in where it has
// none. These are the sections of the Organization page, which is
// its owners' and admins' alone; they manage it with the same cards and the
// same key dialog as a person's Bring Your Own Keys page.
//
// `can_manage` is the server's word on the caller. Somebody demoted while
// the page was open is shown what is set up and offered nothing to change.

type PendingMfa =
  | { kind: "toggle"; provider: ApiKeyProvider; enabled: boolean }
  | { kind: "policy"; allowed: boolean }
  | { kind: "models"; provider: RouterSlug; models: string[] };

const LOAD_ERROR = "The organization's model providers could not be loaded.";
const UPDATE_ERROR = "The provider could not be updated. Please try again.";
const POLICY_ERROR = "The setting could not be updated. Please try again.";

export function OrganizationProviderKeys({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}) {
  const { refreshOrgApiKeys } = useWorkspace();
  const [settings, setSettings] = useState<OrgApiKeySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ApiKeyProvider | "policy" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingMfa, setPendingMfa] = useState<PendingMfa | null>(null);
  const [selectedProvider, setSelectedProvider] =
    useState<ApiKeyProvider | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSettings(await getOrgApiKeys(orgId));
    } catch (error) {
      setLoadError(userFacingApiError(error, LOAD_ERROR));
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // What was saved here is what the model pickers offer when this is the
  // active workspace, so they are told as soon as it changes.
  const applied = useCallback(
    (next: OrgApiKeySettings) => {
      setSettings(next);
      void refreshOrgApiKeys();
    },
    [refreshOrgApiKeys],
  );

  const loading = settings === null && loadError === null;
  const canManage = settings?.can_manage === true;
  const hasOrgKey = (provider: ApiKeyProvider) =>
    settings?.keys.sources?.[provider] === "org";
  const isEnabled = (provider: ApiKeyProvider) =>
    settings?.keys.enabled?.[provider] !== false;
  const selected =
    MODEL_API_KEY_FIELDS.find((field) => field.provider === selectedProvider) ??
    null;

  async function toggleProvider(provider: ApiKeyProvider, enabled: boolean) {
    setBusy(provider);
    try {
      applied(await setOrgApiKeyEnabled(orgId, provider, enabled));
    } catch (error) {
      if (isMfaRequiredError(error))
        setPendingMfa({ kind: "toggle", provider, enabled });
      else setActionError(userFacingApiError(error, UPDATE_ERROR));
    } finally {
      setBusy(null);
    }
  }

  async function setPersonalKeysAllowed(allowed: boolean) {
    setBusy("policy");
    try {
      applied(await setOrgPersonalApiKeysAllowed(orgId, allowed));
    } catch (error) {
      if (isMfaRequiredError(error)) setPendingMfa({ kind: "policy", allowed });
      else setActionError(userFacingApiError(error, POLICY_ERROR));
    } finally {
      setBusy(null);
    }
  }

  // The key dialog shows a rejected value's own reason and runs the MFA
  // prompt itself, so those two are passed up to it rather than swallowed.
  async function saveKey(
    provider: ApiKeyProvider,
    value: string | null,
    keySettings?: ApiKeySettings[keyof ApiKeySettings],
  ): Promise<boolean> {
    try {
      applied(
        await saveOrgApiKey(orgId, provider, value?.trim() || null, keySettings),
      );
      return true;
    } catch (error) {
      if (isMfaRequiredError(error)) throw error;
      if (error instanceof MikeApiError && error.status === 400) throw error;
      return false;
    }
  }

  // The model list field reports a save as done or not done. When the server
  // asks for MFA first, its answer waits here for the retry (or the cancel).
  const modelsAfterMfa = useRef<((saved: boolean) => void) | null>(null);
  async function saveModels(
    provider: RouterSlug,
    models: string[],
  ): Promise<boolean> {
    try {
      applied(await saveOrgRouterModels(orgId, provider, models));
      return true;
    } catch (error) {
      if (!isMfaRequiredError(error)) return false;
      return new Promise<boolean>((resolve) => {
        modelsAfterMfa.current = resolve;
        setPendingMfa({ kind: "models", provider, models });
      });
    }
  }

  const renderToggle = (field: ModelApiKeyField, label: string) => (
    <ToggleSwitchUI
      checked={isEnabled(field.provider)}
      disabled={busy !== null || pendingMfa !== null}
      aria-busy={busy === field.provider}
      aria-label={label}
      onCheckedChange={(enabled) => void toggleProvider(field.provider, enabled)}
    />
  );

  const renderCard = (field: ModelApiKeyField) => {
    const saved = hasOrgKey(field.provider);
    const blocked = loading || busy === field.provider;
    const open = () => {
      if (!blocked) setSelectedProvider(field.provider);
    };
    return (
      <ConnectorCard
        key={field.provider}
        kind="provider"
        name={field.name}
        icon={<ModelProviderIcon field={field} loading={loading} />}
        onOpen={canManage && saved ? open : undefined}
        action={
          loading ? (
            // Whether this is a switch, an Add button or plain text depends
            // on the caller's role, which is not known yet.
            <span className="block h-5 w-9 animate-pulse rounded-full bg-gray-200" />
          ) : !canManage ? (
            // Read-only: say what the switch would say, as plain text.
            <span className="text-sm text-gray-500">
              {isEnabled(field.provider) ? "On" : "Off"}
            </span>
          ) : saved ? (
            renderToggle(field, `${field.name} provider`)
          ) : (
            <PillButtonUI
              tone="blue"
              size="sm"
              disabled={blocked}
              aria-label={`Add ${field.name}`}
              aria-haspopup="dialog"
              onClick={open}
            >
              Add
            </PillButtonUI>
          )
        }
      />
    );
  };

  if (loadError)
    return (
      <div className="space-y-3" role="alert">
        <SettingsDescription>{loadError}</SettingsDescription>
        <PillButtonUI tone="white" size="sm" onClick={() => void load()}>
          Try again
        </PillButtonUI>
      </div>
    );

  const savedFields = MODEL_API_KEY_FIELDS.filter(
    (field) => !loading && hasOrgKey(field.provider),
  );
  const availableFields = MODEL_API_KEY_FIELDS.filter(
    (field) => loading || !hasOrgKey(field.provider),
  );
  const allowPersonal = settings?.allow_personal_api_keys !== false;

  return (
    <>
      <div className="@container space-y-8">
        <section
          aria-labelledby="org-providers-saved"
          className="space-y-3"
        >
          <SettingsHeading id="org-providers-saved">
            Organization Providers
          </SettingsHeading>
          {loading ? (
            <span className="block h-5 w-56 max-w-full animate-pulse rounded bg-gray-200" />
          ) : savedFields.length === 0 ? (
            <SettingsDescription>
              {canManage
                ? "No providers yet. Add an API key to one of the providers below."
                : "This organization has not set up a model provider yet."}
            </SettingsDescription>
          ) : (
            <div className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2">
              {savedFields.map(renderCard)}
            </div>
          )}
        </section>

        {/* Members cannot add a provider, so the list of ones to add is the
            managers' alone. It stays up while loading so the page does not
            jump once the role is known. */}
        {loading || canManage ? (
          <section
            aria-labelledby="org-providers-available"
            className="space-y-3"
          >
            <SettingsHeading id="org-providers-available">
              Available Providers
            </SettingsHeading>
            {availableFields.length === 0 ? (
              <SettingsDescription>
                Every provider has a key saved.
              </SettingsDescription>
            ) : (
              <div
                className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2"
                aria-busy={loading}
              >
                {availableFields.map(renderCard)}
              </div>
            )}
          </section>
        ) : null}

        <section aria-labelledby="org-providers-personal" className="space-y-3">
          <SettingsHeading id="org-providers-personal">
            Members&rsquo; Own Keys
          </SettingsHeading>
          <GlassCardUI>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
              <div className="min-w-0 flex-[1_1_16rem] space-y-1">
                <SettingsLabel>Allow members&rsquo; own keys</SettingsLabel>
                <SettingsDescription>
                  {allowPersonal
                    ? "A member's own key is used for a provider the organization has not set up."
                    : "A member's own keys are never used for work in this organization."}
                </SettingsDescription>
              </div>
              <div className="ml-auto flex shrink-0 items-center">
                {loading ? (
                  <span className="block h-5 w-9 animate-pulse rounded-full bg-gray-200" />
                ) : canManage ? (
                  <ToggleSwitchUI
                    checked={allowPersonal}
                    disabled={busy !== null || pendingMfa !== null}
                    aria-busy={busy === "policy"}
                    aria-label="Allow members' own keys"
                    onCheckedChange={(allowed) =>
                      void setPersonalKeysAllowed(allowed)
                    }
                  />
                ) : (
                  <span className="text-sm text-gray-500">
                    {allowPersonal ? "On" : "Off"}
                  </span>
                )}
              </div>
            </div>
          </GlassCardUI>
        </section>
      </div>

      {canManage ? (
        <ByokProviderModal
          provider={selected}
          store={{
            hasSavedKey: selected ? hasOrgKey(selected.provider) : false,
            settings: settings?.keys.settings,
            save: saveKey,
            breadcrumb: orgName,
            routerModels: {
              configured: hasOrgKey,
              selections: routerSelectionsFromLists(settings?.router_models),
              settings: settings?.keys.settings,
              save: saveModels,
              workspace: orgId,
              description:
                "Add the models this organization's key may run. Members see them in model selectors.",
            },
          }}
          enabledToggle={
            selected && hasOrgKey(selected.provider)
              ? renderToggle(selected, `Use ${selected.name}`)
              : undefined
          }
          onClose={() => setSelectedProvider(null)}
        />
      ) : null}
      <MfaVerificationPopup
        open={pendingMfa !== null}
        onCancel={() => {
          setPendingMfa(null);
          modelsAfterMfa.current?.(false);
          modelsAfterMfa.current = null;
        }}
        onVerified={() => {
          if (!pendingMfa) return;
          const action = pendingMfa;
          setPendingMfa(null);
          if (action.kind === "toggle")
            void toggleProvider(action.provider, action.enabled);
          else if (action.kind === "policy")
            void setPersonalKeysAllowed(action.allowed);
          else {
            const answer = modelsAfterMfa.current;
            modelsAfterMfa.current = null;
            void saveModels(action.provider, action.models).then((saved) =>
              answer?.(saved),
            );
          }
        }}
      />
      <WarningPopup
        open={actionError !== null}
        title="Provider update failed"
        message={actionError}
        onClose={() => setActionError(null)}
      />
    </>
  );
}
