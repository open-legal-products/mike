"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Modal } from "@/app/components/modals/Modal";
import {
  type CourtListenerConnectorStatus,
  deleteCourtListenerConnectorToken,
  getCourtListenerConnector,
  saveCourtListenerConnectorToken,
  setCourtListenerConnectorEnabled,
} from "@/app/lib/mikeApi";
import { ApiKeyField } from "./ApiKeyField";

export const COURTLISTENER_NAME = "CourtListener";

export function CourtListenerIcon() {
  return (
    <Image
      src="/icons/integrations/courtlistener.svg"
      alt=""
      aria-hidden="true"
      width={20}
      height={20}
      unoptimized
      className="h-5 w-5 object-contain"
    />
  );
}

/**
 * CourtListener as a connector in one workspace ("personal" or an
 * organization id; undefined is read as Personal). It is listed under
 * Installed while it is switched on and has a token (the user's own for this
 * workspace, or the organization's) or the deployment's bulk index, or while
 * the user has saved a token of their own here; otherwise it is offered in
 * Discover. The on/off switch and the user's own token are kept per
 * workspace; the token is managed in CourtListenerTokenModal.
 *
 * Every action throws on failure, so the caller can route errors and MFA
 * challenges as it does for the other connectors.
 */
export function useCourtListenerConnector(workspace?: string) {
  const [status, setStatus] = useState<CourtListenerConnectorStatus | null>(
    null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    let mounted = true;
    getCourtListenerConnector(workspace)
      .then((next) => {
        if (!mounted) return;
        setStatus(next);
        setLoadFailed(false);
      })
      .catch(() => {
        if (mounted) setLoadFailed(true);
      });
    return () => {
      mounted = false;
    };
  }, [workspace]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      setOptimisticEnabled(next);
      setBusy(true);
      try {
        setStatus(await setCourtListenerConnectorEnabled(next, workspace));
      } finally {
        // On failure, dropping the optimistic value puts the switch back.
        setBusy(false);
        setOptimisticEnabled(null);
      }
    },
    [workspace],
  );

  const saveToken = useCallback(
    async (token: string) => {
      setStatus(await saveCourtListenerConnectorToken(token, workspace));
    },
    [workspace],
  );

  const deleteToken = useCallback(async () => {
    setStatus(await deleteCourtListenerConnectorToken(workspace));
  }, [workspace]);

  return {
    status,
    loading: !status && !loadFailed,
    loadFailed,
    installed: status?.installed === true,
    enabled: optimisticEnabled ?? status?.enabled ?? true,
    busy,
    setEnabled,
    saveToken,
    deleteToken,
  };
}

export type CourtListenerConnector = ReturnType<
  typeof useCourtListenerConnector
>;

/**
 * Add (no token yet) or Manage (token saved) dialog: the token field, Save,
 * and Delete for a token the user saved themselves in this workspace. When
 * the organization supplies a token, or the deployment's bulk index is in
 * use (it is installed and CourtListener is on), the dialog says so.
 */
export function CourtListenerTokenModal({
  open,
  onClose,
  connector,
  organizationName,
}: {
  open: boolean;
  onClose: () => void;
  connector: CourtListenerConnector;
  /** The active organization's name, or null in Personal. */
  organizationName: string | null;
}) {
  if (!open) return null;
  const status = connector.status;
  const hasOwnToken = status?.ownToken === true;
  const organizationToken = status?.tokenSource === "org";

  return (
    <ApiKeyField
      variant="modal"
      label="CourtListener API token"
      keyLabel={organizationToken ? "Your API token (optional)" : "API token"}
      hasSavedKey={hasOwnToken}
      onSave={async (value) => {
        // Saving a token also turns the connector on (server-side), as
        // adding every other connector does.
        await connector.saveToken(value.trim());
        onClose();
        return true;
      }}
      onRemove={async () => {
        await connector.deleteToken();
        onClose();
        return true;
      }}
      render={(fields, saveAction, removeAction) => (
        <Modal
          open
          onClose={onClose}
          breadcrumbs={["Connectors", COURTLISTENER_NAME]}
          size="sm"
          className="h-auto max-h-[calc(100vh-2rem)]"
          primaryAction={{ ...saveAction, variant: "blue" }}
          secondaryAction={
            removeAction
              ? { ...removeAction, label: "Delete", variant: "danger" }
              : undefined
          }
        >
          <div
            data-modal-scroll="vertical"
            className="min-h-0 min-w-0 space-y-4 overflow-y-auto pb-4"
          >
            {organizationToken && (
              <p className="text-sm break-words text-gray-500">
                {organizationName ?? "Your organization"} provides a
                CourtListener token, so your own token is optional.
              </p>
            )}
            {status?.bulkData && connector.enabled && (
              <p className="text-sm text-gray-500">
                Bulk data installed and in use
              </p>
            )}
            {fields}
          </div>
        </Modal>
      )}
    />
  );
}
