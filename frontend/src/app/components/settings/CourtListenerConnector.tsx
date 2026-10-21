"use client";

import { useState } from "react";
import { Scale } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { ApiKeyField } from "./ApiKeyField";
import { ConnectorCard } from "./ConnectorCard";

const NAME = "CourtListener";

/** Where the token the CourtListener tools will use comes from. */
export function courtListenerTokenStatus(
  source: ApiKeyState["courtlistener"]["source"] | undefined,
): string {
  if (source === "user") return "Uses your API token";
  if (source === "org") return "Uses your organization's API token";
  if (source === "env") return "Uses this deployment's API token";
  return "Needs an API token";
}

/**
 * CourtListener as a built-in connector: the on/off switch is the US case
 * law research setting, and Manage holds the user's own API token. Unlike
 * the connections under Installed it is not tied to the Personal workspace;
 * the assistant can use it in every workspace's chats.
 */
export function CourtListenerConnector() {
  const { profile, updateApiKey, updateLegalResearchUs } = useUserProfile();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(
    null,
  );

  const enabled = optimisticEnabled ?? profile?.legalResearchUs ?? true;
  const tokenSource = profile?.apiKeys.courtlistener.source;
  const status = profile ? courtListenerTokenStatus(tokenSource) : undefined;

  const setEnabled = async (next: boolean) => {
    if (saving) return;
    setOptimisticEnabled(next);
    setSaving(true);
    // A failure is reported by the profile context's notice (with Retry);
    // dropping the optimistic value puts the switch back.
    await updateLegalResearchUs(next);
    setSaving(false);
    setOptimisticEnabled(null);
  };

  const toggle = (label: string) => (
    <ToggleSwitchUI
      checked={enabled}
      disabled={!profile || saving}
      aria-busy={saving}
      aria-label={label}
      onCheckedChange={(next) => void setEnabled(next)}
    />
  );

  return (
    <>
      <ConnectorCard
        name={NAME}
        detail={status}
        icon={<Scale className="h-5 w-5 text-gray-700" aria-hidden="true" />}
        onOpen={() => setOpen(true)}
        action={toggle(`${NAME} connector`)}
      />
      {open && (
        <ApiKeyField
          variant="modal"
          label="CourtListener API token"
          keyLabel="API token"
          hasSavedKey={tokenSource === "user"}
          onSave={(value) => updateApiKey("courtlistener", value.trim() || null)}
          onRemove={() => updateApiKey("courtlistener", null)}
          render={(fields, saveAction, removeAction) => (
            <Modal
              open
              onClose={() => setOpen(false)}
              breadcrumbs={["Connectors", NAME]}
              size="sm"
              className="h-auto max-h-[calc(100vh-2rem)]"
              primaryAction={{ ...saveAction, variant: "blue" }}
              secondaryAction={
                removeAction
                  ? { ...removeAction, label: "Clear", variant: "danger" }
                  : undefined
              }
            >
              <div
                data-modal-scroll="vertical"
                className="min-h-0 min-w-0 space-y-6 overflow-y-auto pb-4"
              >
                <p className="text-sm text-gray-500">
                  US case law from the Free Law Project. The assistant can
                  search opinions, read cases and verify citations in
                  assistant and project chats in every workspace.
                </p>
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 text-sm font-medium text-gray-700">
                    Enabled
                  </p>
                  <div className="shrink-0">{toggle(`Enable ${NAME}`)}</div>
                </div>
                <div className="space-y-2">
                  <p role="status" className="text-sm text-gray-500">
                    {status}
                  </p>
                  {fields}
                </div>
              </div>
            </Modal>
          )}
        />
      )}
    </>
  );
}
