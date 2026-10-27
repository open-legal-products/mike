// Business logic + data-access for the admin module: what an instance admin
// (MIKE_ADMIN_EMAILS) may read and change about this deployment.
//
// Today that is feature flags: the deployment default of each flag and the
// per-user overrides. Functions take an explicit Supabase client (`db`) plus
// request-derived primitives and return ServiceResults; admin.routes.ts maps
// them onto HTTP. The flag registry and the resolution rule live in
// lib/featureFlags.ts, so a chat turn and the admin panel can never disagree
// about what a user gets.

import type { Db } from "../../lib/supabase";
import { recordAudit } from "../../lib/audit";
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  isFeatureFlagKey,
  loadFeatureFlagDefaults,
  resolveFeatureFlags,
  setFeatureFlagDefault,
  setUserFeatureFlag,
  type FeatureFlagKey,
} from "../../lib/featureFlags";
import { findProfileUserByEmail, normalizeEmail } from "../../lib/userLookup";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import type {
  AdminFeatureFlagsResponse,
  AdminUserFeatureFlags,
  FeatureFlagSummary,
} from "@mike/contracts";

type Actor = { userId: string; email: string | undefined };

function summaries(
  defaults: Partial<Record<FeatureFlagKey, boolean>>,
): FeatureFlagSummary[] {
  return FEATURE_FLAG_KEYS.map((key) => {
    const definition = FEATURE_FLAGS[key];
    const codeDefault = definition.codeDefault();
    const deploymentDefault = defaults[key] ?? null;
    return {
      key,
      label: definition.label,
      description: definition.description,
      group: definition.group,
      codeDefault,
      deploymentDefault,
      effectiveDefault: deploymentDefault ?? codeDefault,
    };
  });
}

/** Every flag with its code default and the deployment default, if an admin set one. */
export async function listFeatureFlags(
  db: Db,
): Promise<ServiceResult<AdminFeatureFlagsResponse>> {
  try {
    return ok({ flags: summaries(await loadFeatureFlagDefaults(db)) });
  } catch (error) {
    return internalFailure(error);
  }
}

/** `enabled: null` clears the deployment default so the code default applies again. */
export async function updateFeatureFlagDefault(
  db: Db,
  actor: Actor,
  args: { key: string; enabled: unknown },
): Promise<ServiceResult<AdminFeatureFlagsResponse>> {
  if (!isFeatureFlagKey(args.key))
    return failure("not_found", "Unknown feature flag.");
  if (args.enabled !== null && typeof args.enabled !== "boolean")
    return failure("validation", "enabled must be true, false or null.");
  try {
    await setFeatureFlagDefault(db, args.key, args.enabled, actor.userId);
    await recordAudit(db, {
      userId: actor.userId,
      userEmail: actor.email ?? null,
      action: "feature_flag.default_updated",
      title: FEATURE_FLAGS[args.key].label,
      detail: { flag: args.key, enabled: args.enabled },
    });
    return ok({ flags: summaries(await loadFeatureFlagDefaults(db)) });
  } catch (error) {
    return internalFailure(error);
  }
}

async function userFlags(
  db: Db,
  user: { id: string; email: string; display_name: string | null },
): Promise<AdminUserFeatureFlags> {
  const resolved = await resolveFeatureFlags(db, user.id);
  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    flags: FEATURE_FLAG_KEYS.map((key) => ({
      key,
      override: resolved[key].override,
      enabled: resolved[key].enabled,
    })),
  };
}

/** The flags one user actually gets, found by the address they signed up with. */
export async function findUserFeatureFlagsByEmail(
  db: Db,
  email: unknown,
): Promise<ServiceResult<AdminUserFeatureFlags>> {
  const normalized = normalizeEmail(email);
  if (!normalized) return failure("validation", "email is required.");
  try {
    const user = await findProfileUserByEmail(db, normalized);
    if (!user) return failure("not_found", "No account has that email address.");
    return ok(await userFlags(db, user));
  } catch (error) {
    return internalFailure(error);
  }
}

/** `enabled: null` clears the override so the deployment default applies again. */
export async function updateUserFeatureFlag(
  db: Db,
  actor: Actor,
  args: { userId: string; key: string; enabled: unknown },
): Promise<ServiceResult<AdminUserFeatureFlags>> {
  if (!isFeatureFlagKey(args.key))
    return failure("not_found", "Unknown feature flag.");
  if (args.enabled !== null && typeof args.enabled !== "boolean")
    return failure("validation", "enabled must be true, false or null.");
  try {
    const user = await findProfileUserById(db, args.userId);
    if (!user) return failure("not_found", "No account has that id.");
    await setUserFeatureFlag(db, user.id, args.key, args.enabled, actor.userId);
    await recordAudit(db, {
      userId: actor.userId,
      userEmail: actor.email ?? null,
      action: "feature_flag.user_updated",
      title: FEATURE_FLAGS[args.key].label,
      detail: { flag: args.key, enabled: args.enabled, subjectUserId: user.id },
    });
    return ok(await userFlags(db, user));
  } catch (error) {
    return internalFailure(error);
  }
}

async function findProfileUserById(
  db: Db,
  userId: string,
): Promise<{ id: string; email: string; display_name: string | null } | null> {
  const { data, error } = await db
    .from("user_profiles")
    .select("user_id, email, display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.user_id as string,
    email: normalizeEmail(data.email),
    display_name:
      typeof data.display_name === "string" && data.display_name.trim()
        ? data.display_name.trim()
        : null,
  };
}
