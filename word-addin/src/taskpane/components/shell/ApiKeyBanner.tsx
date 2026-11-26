import React, { useEffect, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { WEB_APP_URL, openExternalUrl } from "../../lib/openExternalUrl";
import { useAddinWorkspace } from "../../lib/addinWorkspace";
import { hasConfiguredModelProvider } from "../../lib/modelCatalog";
import { loadWorkspaceModelAccess } from "../../lib/workspaceModels";

const DISMISS_KEY = "apiKeyBannerDismissed";

// The web app hosts the API-keys settings page; the task pane only links to it.
const API_KEYS_PAGE_URL = `${WEB_APP_URL}/settings/byok`;

// An organization's keys are set on its own settings page, by its owners and
// admins.
function organizationKeysPageUrl(orgId: string): string {
  return `${WEB_APP_URL}/organizations/${encodeURIComponent(orgId)}/settings/providers`;
}

/** What the banner says, for the workspace it was read for. */
type MissingKey =
  | { scope: "personal" }
  | { scope: "organization"; orgId: string; canManage: boolean };

function isDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Banner shown under the header when the pane's workspace has no AI provider
 * key configured: in Personal, neither a platform env key nor a personal key;
 * in an organization, none of the keys the organization's work runs on. Without one,
 * every chat/action errors out ("invalid x-api-key"), so we nudge towards the
 * web app's API-keys page instead of letting the user discover it per-request.
 *
 * Only renders on a POSITIVE "no key" answer from the backend — while loading,
 * or if the status call fails, nothing is shown (the per-request error paths
 * already cover that). Dismissible for the session, like the web banner.
 */
export function ApiKeyBanner(): React.ReactElement | null {
  const { workspaceId, ready } = useAddinWorkspace();
  const [missingKey, setMissingKey] = useState<MissingKey | null>(null);
  const [dismissed, setDismissed] = useState(isDismissed);

  useEffect(() => {
    // Another workspace's answer never shows under this one.
    setMissingKey(null);
    if (!ready) return;
    let cancelled = false;
    loadWorkspaceModelAccess(workspaceId)
      .then((access) => {
        if (cancelled || hasConfiguredModelProvider(access.keyStatus)) return;
        setMissingKey(
          access.orgId
            ? {
                scope: "organization",
                orgId: access.orgId,
                canManage: access.canManage,
              }
            : { scope: "personal" },
        );
      })
      .catch(() => {
        // Unknown status — stay hidden rather than nag on a network blip.
      });
    return () => {
      cancelled = true;
    };
  }, [ready, workspaceId]);

  if (!missingKey || dismissed) return null;

  const handleDismiss = (): void => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "true");
    } catch {
      // Storage unavailable — dismiss still applies for this mount.
    }
    setDismissed(true);
  };

  const inOrganization = missingKey.scope === "organization";
  // A member who cannot change the organization's keys has nothing to set up.
  const setupUrl =
    missingKey.scope === "organization"
      ? missingKey.canManage
        ? organizationKeysPageUrl(missingKey.orgId)
        : null
      : API_KEYS_PAGE_URL;

  return (
    <div
      role="status"
      className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
        <p className="min-w-0 flex-1">
          <span className="font-medium">
            {inOrganization
              ? "No AI provider key is set up for this organization."
              : "No AI provider key is set up."}
          </span>{" "}
          <span className="text-amber-800">
            {inOrganization && !setupUrl
              ? "Chat and actions will fail until an owner or admin of the organization adds one."
              : "Chat and actions will fail until you add one."}
          </span>
        </p>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 text-amber-500 transition-colors hover:bg-amber-100 hover:text-amber-700"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {setupUrl ? (
        <button
          type="button"
          onClick={() => openExternalUrl(setupUrl)}
          className="mt-1.5 ml-[22px] rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-amber-700"
        >
          Set up API keys
        </button>
      ) : null}
    </div>
  );
}
