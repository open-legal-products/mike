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
// MCP connector credentials and Google Drive / Workspace tokens are encrypted
// with MCP_CONNECTORS_ENCRYPTION_SECRET, which falls back to the same
// USER_API_KEYS_ENCRYPTION_SECRET (lib/mcp/client.ts encryptionSecret). When
// the connector secret is unset, their rows depend on this secret too, so
// they are checked as well.
//
// The check does not stop the boot: an install whose users have never saved
// a key needs no secret, and one that has keeps serving on the deployment's
// keys while the operator fixes the variable.

import { AppError } from "../appError";
import { reportError } from "../observability/sentry";
import { createServerSupabase, type Db } from "../supabase";

interface EncryptedColumn {
  table: string;
  column: string;
}

/** Columns always encrypted with USER_API_KEYS_ENCRYPTION_SECRET. */
export const ENCRYPTED_KEY_COLUMNS: readonly EncryptedColumn[] = [
  { table: "user_api_keys", column: "encrypted_key" },
  { table: "org_api_keys", column: "encrypted_key" },
  { table: "user_courtlistener_connections", column: "encrypted_key" },
];

/**
 * Columns encrypted by lib/mcp/client.ts with MCP_CONNECTORS_ENCRYPTION_SECRET
 * || USER_API_KEYS_ENCRYPTION_SECRET. Short-lived OAuth state rows are left
 * out: they expire within minutes and a lost one only restarts a sign-in.
 */
export const CONNECTOR_ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  { table: "user_mcp_connectors", column: "encrypted_auth_config" },
  { table: "user_mcp_oauth_tokens", column: "encrypted_access_token" },
  { table: "user_google_drive_tokens", column: "encrypted_access_token" },
  { table: "user_google_workspace_tokens", column: "encrypted_access_token" },
];

/** What depends on USER_API_KEYS_ENCRYPTION_SECRET in this environment. */
export function columnsUsingKeySecret(
  env: NodeJS.ProcessEnv,
): readonly EncryptedColumn[] {
  return env.MCP_CONNECTORS_ENCRYPTION_SECRET
    ? ENCRYPTED_KEY_COLUMNS
    : [...ENCRYPTED_KEY_COLUMNS, ...CONNECTOR_ENCRYPTED_COLUMNS];
}

export type EncryptionSecretVerdict =
  | "configured"
  | "no_stored_keys"
  | "missing"
  | "unknown";

async function hasEncryptedRows(
  db: Db,
  columns: readonly EncryptedColumn[],
): Promise<boolean | null> {
  let unknown = false;
  for (const { table, column } of columns) {
    const { data, error } = await db
      .from(table)
      .select("id")
      .not(column, "is", null)
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
 * holds keys or (without MCP_CONNECTORS_ENCRYPTION_SECRET) connector
 * credentials encrypted with it. Never throws.
 */
export async function reportMissingEncryptionSecret(
  env: NodeJS.ProcessEnv = process.env,
  db: () => Db = createServerSupabase,
): Promise<EncryptionSecretVerdict> {
  if (env.USER_API_KEYS_ENCRYPTION_SECRET) return "configured";
  let stored: boolean | null;
  try {
    stored = await hasEncryptedRows(db(), columnsUsingKeySecret(env));
  } catch {
    return "unknown";
  }
  if (stored === null) return "unknown";
  if (!stored) return "no_stored_keys";
  const failure = Object.assign(
    new AppError(
      "config.encryption_secret_missing",
      "USER_API_KEYS_ENCRYPTION_SECRET is not configured but stored keys or connector credentials exist",
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
      "holds API keys or connector credentials encrypted with it. They are ignored until the secret " +
      "is restored (see backend/.env.example).",
  );
  return "missing";
}
