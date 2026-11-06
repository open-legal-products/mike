/**
 * Google services the operator has switched off with
 * GOOGLE_WORKSPACE_DISABLED_PROVIDERS, a comma-separated list of provider
 * ids ("google-drive", "gmail", "google-calendar"). A hosted deployment uses
 * it to offer only the services whose Google scopes its Cloud project has
 * verified, so the consent screen, the Console and the running code keep
 * requesting the same scopes. Unknown ids are reported and ignored rather
 * than disabling nothing silently or taking every service down.
 *
 * The variable is the CODE DEFAULT of the Google feature flags
 * (lib/featureFlags.ts): an instance admin can set a different deployment
 * default or switch a service on or off for one user without redeploying.
 * Per-user answers come from googleAccess.ts; nothing here is per user.
 *
 * Shared by the Drive and Gmail/Calendar integrations, which otherwise keep
 * separate OAuth clients, grants and tools.
 */
export const GOOGLE_SERVICES = {
  "google-drive": "Google Drive",
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
} as const;
export type GoogleService = keyof typeof GOOGLE_SERVICES;

export function disabledGoogleServices(): GoogleService[] {
  const ids = (process.env.GOOGLE_WORKSPACE_DISABLED_PROVIDERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !(id in GOOGLE_SERVICES));
  if (unknown.length)
    console.error("[google-workspace] unknown provider ids in GOOGLE_WORKSPACE_DISABLED_PROVIDERS", {
      unknown,
      known: Object.keys(GOOGLE_SERVICES),
    });
  return ids.filter((id): id is GoogleService => id in GOOGLE_SERVICES);
}

export function isGoogleServiceAvailable(service: GoogleService): boolean {
  return !disabledGoogleServices().includes(service);
}

/** Repo-authored, safe to show the user as written. */
export function googleServiceUnavailableMessage(service: GoogleService): string {
  return `${GOOGLE_SERVICES[service]} is not offered on this Mike server.`;
}

/** The read bundle is on for this user but the write bundle is not (see googleAccess.ts). */
export function googleWriteUnavailableMessage(service: GoogleService): string {
  return `Changes through ${GOOGLE_SERVICES[service]} are not offered on this Mike server.`;
}
