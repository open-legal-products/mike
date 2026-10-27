// Feature flags: what a deployment offers, and to whom.
//
// A flag answers one question per user: is this feature on for them? The
// answer is resolved in three layers, the most specific one winning:
//
//   1. a per-user override an instance admin set (user_feature_flags);
//   2. the deployment default an instance admin set (feature_flag_defaults);
//   3. the code default, which may read deployment configuration.
//
// The registry below is the only list of flags. A flag that is not in it
// cannot be stored, so the admin panel and the database can never disagree
// about which flags exist. Each Google scope bundle is its own flag because
// Google verifies OAuth scopes one by one: a deployment can offer Calendar
// reads to everyone while Gmail is still under review, or switch Gmail on for
// the reviewer's account only (see docs/feature-flags.md).
//
// Shared kernel: lib/ never imports modules/, so this file knows nothing about
// HTTP. The admin module and the Google integrations call it.

import type { Db } from "./supabase";
import { safeError } from "./safeError";
import { disabledGoogleServices } from "./integrations/googleAvailability";

export type FeatureFlagDefinition = {
  label: string;
  description: string;
  /** Flags shown together in the admin panel. */
  group: string;
  /** What applies when neither an admin default nor a user override exists. */
  codeDefault: () => boolean;
};

const googleOn = (service: "google-drive" | "gmail" | "google-calendar") => () =>
  !disabledGoogleServices().includes(service);

export const FEATURE_FLAGS = {
  "google-drive": {
    label: "Google Drive",
    description:
      "Connect Google Drive and use the files added through the Google Picker (drive.file).",
    group: "Google",
    codeDefault: googleOn("google-drive"),
  },
  "gmail-read": {
    label: "Gmail: read",
    description:
      "Connect Gmail and search, read and list mail and drafts (gmail.readonly).",
    group: "Google",
    codeDefault: googleOn("gmail"),
  },
  "gmail-write": {
    label: "Gmail: send and drafts",
    description:
      "Also send new email and create, replace or delete drafts (gmail.compose). Needs Gmail: read.",
    group: "Google",
    codeDefault: googleOn("gmail"),
  },
  "google-calendar-read": {
    label: "Google Calendar: read",
    description:
      "Connect Google Calendar and list calendars and events (calendar.calendarlist.readonly, calendar.events.readonly).",
    group: "Google",
    codeDefault: googleOn("google-calendar"),
  },
  "google-calendar-write": {
    label: "Google Calendar: change events",
    description:
      "Also create, change and delete events (calendar.events). Needs Google Calendar: read.",
    group: "Google",
    codeDefault: googleOn("google-calendar"),
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

export function isFeatureFlagKey(value: unknown): value is FeatureFlagKey {
  return typeof value === "string" && Object.hasOwn(FEATURE_FLAGS, value);
}

/** One flag's three layers and the answer they produce for a user. */
export type FeatureFlagState = {
  codeDefault: boolean;
  /** Set by an admin for the whole deployment; null means "use the code default". */
  deploymentDefault: boolean | null;
  /** Set by an admin for this user; null means "use the deployment default". */
  override: boolean | null;
  enabled: boolean;
};

export type ResolvedFeatureFlags = Record<FeatureFlagKey, FeatureFlagState>;

// A deployment whose database predates the flag tables keeps behaving as
// before: every layer above the code default is empty. The tables are
// created by backend/migrations/20261027_01_feature_flags.sql.
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "PGRST205" || code === "42P01";
}

type FlagRow = { flag: string; enabled: boolean };

function toMap(rows: FlagRow[] | null | undefined): Partial<Record<FeatureFlagKey, boolean>> {
  const map: Partial<Record<FeatureFlagKey, boolean>> = {};
  for (const row of rows ?? [])
    if (isFeatureFlagKey(row.flag)) map[row.flag] = row.enabled === true;
  return map;
}

/** Deployment defaults an admin has set, keyed by flag. */
export async function loadFeatureFlagDefaults(
  db: Db,
): Promise<Partial<Record<FeatureFlagKey, boolean>>> {
  const { data, error } = await db
    .from("feature_flag_defaults")
    .select("flag, enabled");
  if (error) {
    if (isMissingTableError(error)) return {};
    throw error;
  }
  return toMap(data as FlagRow[] | null);
}

/** Overrides an admin has set for one user, keyed by flag. */
export async function loadUserFeatureFlagOverrides(
  db: Db,
  userId: string,
): Promise<Partial<Record<FeatureFlagKey, boolean>>> {
  const { data, error } = await db
    .from("user_feature_flags")
    .select("flag, enabled")
    .eq("user_id", userId);
  if (error) {
    if (isMissingTableError(error)) return {};
    throw error;
  }
  return toMap(data as FlagRow[] | null);
}

/** Every flag's state for one user: override, then deployment default, then code default. */
export async function resolveFeatureFlags(
  db: Db,
  userId: string,
): Promise<ResolvedFeatureFlags> {
  const [defaults, overrides] = await Promise.all([
    loadFeatureFlagDefaults(db),
    loadUserFeatureFlagOverrides(db, userId),
  ]);
  const resolved = {} as ResolvedFeatureFlags;
  for (const key of FEATURE_FLAG_KEYS) {
    const codeDefault = FEATURE_FLAGS[key].codeDefault();
    const deploymentDefault = defaults[key] ?? null;
    const override = overrides[key] ?? null;
    resolved[key] = {
      codeDefault,
      deploymentDefault,
      override,
      enabled: override ?? deploymentDefault ?? codeDefault,
    };
  }
  return resolved;
}

export async function isFeatureEnabled(
  db: Db,
  userId: string,
  key: FeatureFlagKey,
): Promise<boolean> {
  return (await resolveFeatureFlags(db, userId))[key].enabled;
}

/**
 * Sets, or with `enabled: null` clears, the deployment default of one flag.
 * The caller has already checked that the actor is an instance admin.
 */
export async function setFeatureFlagDefault(
  db: Db,
  key: FeatureFlagKey,
  enabled: boolean | null,
  actorId: string,
): Promise<void> {
  const { error } =
    enabled === null
      ? await db.from("feature_flag_defaults").delete().eq("flag", key)
      : await db.from("feature_flag_defaults").upsert(
          {
            flag: key,
            enabled,
            updated_by: actorId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "flag" },
        );
  if (error) throw error;
}

/** Sets, or with `enabled: null` clears, one user's override of one flag. */
export async function setUserFeatureFlag(
  db: Db,
  userId: string,
  key: FeatureFlagKey,
  enabled: boolean | null,
  actorId: string,
): Promise<void> {
  const { error } =
    enabled === null
      ? await db
          .from("user_feature_flags")
          .delete()
          .eq("user_id", userId)
          .eq("flag", key)
      : await db.from("user_feature_flags").upsert(
          {
            user_id: userId,
            flag: key,
            enabled,
            updated_by: actorId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,flag" },
        );
  if (error) throw error;
}

/** Logged, never thrown: a flag read that fails must not take a request down with the raw error. */
export function reportFeatureFlagError(context: string, error: unknown): void {
  console.error(`[feature-flags] ${context}`, safeError(error));
}
