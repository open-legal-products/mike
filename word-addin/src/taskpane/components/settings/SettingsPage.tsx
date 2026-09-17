import React from "react";
import { Trash2 } from "lucide-react";
import { ToggleSwitchUI } from "@mike/toggle-switch-ui";
import { PageTitle } from "../primitives/PageTitle";
import { PillButtonUI as PillButton } from "@mike/pill-button-ui";
import type { WordChatStorageMode } from "../../lib/wordChatSettings";
import { Modal } from "../primitives/Modal";
import { GlassCardUI } from "@mike/glass-card-ui";

interface SettingsPageProps {
  storageMode: WordChatStorageMode;
  onStorageModeChange: (mode: WordChatStorageMode) => Promise<void>;
  onClearLocalChats: () => Promise<void>;
}

export function SettingsPage({
  storageMode,
  onStorageModeChange,
  onClearLocalChats,
}: SettingsPageProps): React.ReactElement {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

  const updateMode = async (cloud: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onStorageModeChange(cloud ? "cloud" : "local");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save the chat storage setting.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <PageTitle className="mb-5 px-1">Settings</PageTitle>
      <section>
        <GlassCardUI>
          <div className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-gray-900">
                  Save chats in the cloud
                </h2>
                <p className="mt-1 text-xs leading-5 text-gray-500">
                  Cloud chats are linked to this Word document and available on
                  your other devices.
                </p>
              </div>
              <ToggleSwitchUI
                aria-label="Save chats in the cloud"
                checked={storageMode === "cloud"}
                disabled={saving}
                onCheckedChange={(checked) => void updateMode(checked)}
              />
            </div>

            {error && (
              <p role="alert" className="mt-3 text-xs text-red-600">
                {error}
              </p>
            )}
          </div>
        </GlassCardUI>
      </section>

      <section className="mt-3">
        <GlassCardUI>
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-gray-900">
                Device-only chats
              </h2>
              <p className="mt-1 text-xs leading-5 text-gray-500">
                Local chats remain readable in this device profile after
                sign-out until you delete them.
              </p>
            </div>
            <PillButton
              tone="danger"
              onClick={() => setClearConfirmOpen(true)}
              className="shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </PillButton>
          </div>
        </GlassCardUI>
      </section>

      <Modal
        open={clearConfirmOpen}
        onClose={() => !clearing && setClearConfirmOpen(false)}
        title="Delete device-only chats?"
        primaryAction={{
          label: clearing ? "Deleting…" : "Delete chats",
          tone: "danger",
          disabled: clearing,
          onClick: () => {
            setClearing(true);
            setError(null);
            void onClearLocalChats()
              .then(() => setClearConfirmOpen(false))
              .catch((reason: unknown) =>
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Could not delete device-only chats.",
                ),
              )
              .finally(() => setClearing(false));
          },
        }}
        secondaryAction={{
          label: "Cancel",
          disabled: clearing,
          onClick: () => setClearConfirmOpen(false),
        }}
        className="h-auto max-h-[calc(100vh-2rem)]"
      >
        <p className="pb-5 text-sm leading-6 text-gray-600">
          This permanently deletes every device-only Word chat saved for this
          account on this device. Cloud chats are not affected.
        </p>
      </Modal>
    </div>
  );
}
