// Boot-time check that stored API keys can be read.
//
// Every saved provider key and CourtListener token is encrypted with
// USER_API_KEYS_ENCRYPTION_SECRET. Without it the deployment still works on
// its environment keys, but every key a person saved is silently ignored.
// That used to surface only as one context-free Sentry event per key READ
// (MIKE-BACKEND-7K, -7E), long after the operator could connect it to the
// missing variable. It is a configuration fault, so it is reported once, at
// boot, with a configuration kind; the per-read path only warns locally.
//
// The check does not stop the boot: an install whose users have never saved
// a key needs no secret, and one that has keeps serving on the deployment's
// keys while the operator fixes the variable.

import { AppError } from "../appError";
import { reportError } from "../observability/sentry";
import { createServerSupabase, type Db } from "../supabase";

/** Tables whose rows are encrypted with USER_API_KEYS_ENCRYPTION_SECRET. */
export const ENCRYPTED_KEY_TABLES = [
  "user_api_keys",
  "org_api_keys",
  "user_courtlistener_connections",
] as const;

export type EncryptionSecretVerdict =
  | "configured"
  | "no_stored_keys"
  | "missing"
  | "unknown";

async function hasEncryptedRows(db: Db): Promise<boolean | null> {
  let unknown = false;
  for (const table of ENCRYPTED_KEY_TABLES) {
    const { data, error } = await db
      .from(table)
      .select("id")
      .not("encrypted_key", "is", null)
      .limit(1);
    if (error) {
      // An unmigrated table or an unreachable database is not this check's
      // to report; the lifecycle guard and the first request say so.
      unknown = true;
      continue;
    }
    if (Array.isArray(data) && data.length > 0) return true;
  }
  return unknown ? null : false;
}

/**
 * Report a missing USER_API_KEYS_ENCRYPTION_SECRET once when the database
 * holds keys encrypted with it. Never throws.
 */
export async function reportMissingEncryptionSecret(
  env: NodeJS.ProcessEnv = process.env,
  db: () => Db = createServerSupabase,
): Promise<EncryptionSecretVerdict> {
  if (env.USER_API_KEYS_ENCRYPTION_SECRET) return "configured";
  let stored: boolean | null;
  try {
    stored = await hasEncryptedRows(db());
  } catch {
    return "unknown";
  }
  if (stored === null) return "unknown";
  if (!stored) return "no_stored_keys";
  const failure = Object.assign(
    new AppError(
      "config.encryption_secret_missing",
      "USER_API_KEYS_ENCRYPTION_SECRET is not configured but stored API keys exist",
    ),
    {
      code: "configuration_invalid",
      // Field names only, as validateRuntimeConfiguration does.
      configurationFields: ["USER_API_KEYS_ENCRYPTION_SECRET"],
    },
  );
  reportError(failure, {
    level: "error",
    tags: { component: "boot", stage: "encryption-secret" },
  });
  console.warn(
    "[startup] USER_API_KEYS_ENCRYPTION_SECRET is not configured, but the database " +
      "holds API keys encrypted with it. Those keys are ignored until the secret " +
      "is restored (see backend/.env.example).",
  );
  return "missing";
}
