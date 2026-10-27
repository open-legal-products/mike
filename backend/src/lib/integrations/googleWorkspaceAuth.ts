import type {
  GoogleWorkspaceProvider,
  GoogleWorkspaceStatus,
} from "@mike/contracts";
import crypto from "node:crypto";
import type { Db } from "../supabase";
import { type ConnectorOwner, workspaceFilter } from "../connectorOwner";
import {
  base64Url,
  encryptString,
  decryptString,
  stateHash,
} from "../mcp/client";
import { googleDriveOAuthEnv } from "./googleDrive";
import {
  googleServiceUnavailableMessage,
  googleWriteUnavailableMessage,
} from "./googleAvailability";
import {
  googleServiceAccess,
  type GoogleServiceAccess,
} from "./googleAccess";
import { ConnectorSetupError } from "../mcp/errors";
import { googleDriveRequest } from "./googleDriveHttp";
import {
  connectorSettingsPatch,
  toggleDisabledTool,
  type NativeConnectorSettings,
} from "./connectorSettings";

export type GoogleProvider = GoogleWorkspaceProvider;
export const GOOGLE_PROVIDERS = {
  gmail: {
    name: "Gmail",
    read: ["https://www.googleapis.com/auth/gmail.readonly"],
    write: ["https://www.googleapis.com/auth/gmail.compose"],
  },
  "google-calendar": {
    name: "Google Calendar",
    read: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
    write: ["https://www.googleapis.com/auth/calendar.events"],
  },
} as const;
export class GoogleWorkspaceError extends Error {}
/** This service (or its write bundle) is not offered to this user: see ./googleAccess. */
export class GoogleWorkspaceUnavailableError extends GoogleWorkspaceError {}
/**
 * What this user may do with the service, from their feature flags
 * (./googleAccess). `read` false means the service is not offered to them at
 * all; `write` false means its write scope is never requested and its write
 * tools are never offered, even over a grant that carries the scope.
 */
export function workspaceProviderAccess(
  db: Db,
  userId: string,
  provider: GoogleProvider,
): Promise<GoogleServiceAccess> {
  return googleServiceAccess(db, userId, provider);
}
export async function assertWorkspaceProviderAvailable(
  db: Db,
  userId: string,
  provider: GoogleProvider,
): Promise<GoogleServiceAccess> {
  const access = await workspaceProviderAccess(db, userId, provider);
  if (!access.read)
    throw new GoogleWorkspaceUnavailableError(
      googleServiceUnavailableMessage(provider),
    );
  return access;
}
export function assertWorkspaceWriteAvailable(
  provider: GoogleProvider,
  access: GoogleServiceAccess,
): void {
  if (!access.write)
    throw new GoogleWorkspaceUnavailableError(
      googleWriteUnavailableMessage(provider),
    );
}
export function googleWorkspaceSetupInstructions(
  provider: GoogleProvider,
  redirectUri: string,
): string {
  const api = provider === "gmail" ? "Gmail API" : "Google Calendar API";
  return (
    `${GOOGLE_PROVIDERS[provider].name} needs an OAuth client. Create one in Google Cloud Console ` +
    "(APIs & Services → Credentials → Create credentials → OAuth client ID → " +
    `Web application) with authorized redirect URI ${redirectUri}, enable the ` +
    `${api}, then set GOOGLE_WORKSPACE_OAUTH_CLIENT_ID and ` +
    "GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET (or the Google Drive client variables) " +
    "in backend/.env and restart. The redirect URI is derived from " +
    "API_PUBLIC_URL, so fix that first if it is not the address browsers use to reach Mike."
  );
}
export function googleWorkspaceEnv() {
  if (
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID?.trim() ||
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET?.trim()
  )
    return {
      clientId: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID?.trim(),
      clientSecret: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET?.trim(),
    };
  return googleDriveOAuthEnv();
}
/**
 * Mike asks for write access on every connect for which the user's write
 * flag is on. Google lets the user untick individual permissions and lets
 * Workspace admins block them, so write access is whatever Google actually
 * granted — see `grantedWriteAccess`. With the write flag off the write scope
 * is not requested at all, so the consent screen shows only the read bundle.
 */
export function requestedScopes(
  provider: GoogleProvider,
  access: GoogleServiceAccess = { read: true, write: true },
): string[] {
  const config = GOOGLE_PROVIDERS[provider];
  return [
    "openid",
    "email",
    ...config.read,
    ...(access.write ? config.write : []),
  ];
}
/**
 * Broader scopes that cover narrower ones Mike checks for. gmail.modify was
 * Mike's Gmail write scope before gmail.compose; listing it keeps those grants
 * readable and writable without a reconnect.
 */
const IMPLIED_SCOPES: Record<string, readonly string[]> = {
  "https://www.googleapis.com/auth/gmail.modify": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  "https://www.googleapis.com/auth/calendar.events": [
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ],
};
/** The granted scopes plus every scope they imply. */
function grantedScopes(scope: unknown): string[] {
  const granted = typeof scope === "string" ? scope.split(/\s+/) : [];
  return granted.concat(granted.flatMap((s) => IMPLIED_SCOPES[s] ?? []));
}
function grantedWriteAccess(provider: GoogleProvider, scope: unknown): boolean {
  const scopes = grantedScopes(scope);
  return GOOGLE_PROVIDERS[provider].write.every((s) => scopes.includes(s));
}
export function encryptFields(prefix: string, value: string) {
  const enc = encryptString(value);
  return {
    [`encrypted_${prefix}`]: enc.encrypted,
    [`${prefix}_iv`]: enc.iv,
    [`${prefix}_tag`]: enc.tag,
  };
}
export function decryptFields(
  row: Record<string, unknown>,
  prefix: string,
): string {
  const value = decryptString(
    String(row[`encrypted_${prefix}`]),
    String(row[`${prefix}_iv`]),
    String(row[`${prefix}_tag`]),
  );
  if (!value) throw new Error("Stored Google data could not be decrypted.");
  return value;
}
export async function workspaceRequest(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await googleDriveRequest(url, init, 8 * 1024 * 1024);
  } catch {
    throw new GoogleWorkspaceError(
      "Google did not return a complete response within the request limits. Try a smaller request.",
    );
  }
}
export async function loadWorkspaceGrant(
  db: Db,
  owner: ConnectorOwner,
  provider: GoogleProvider,
) {
  const { data, error } = await db
    .from("user_google_workspace_tokens")
    .select("*")
    .eq("user_id", owner.userId)
    .filter(...workspaceFilter(owner))
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}
export async function workspaceStatus(
  db: Db,
  owner: ConnectorOwner,
  provider: GoogleProvider,
): Promise<Omit<GoogleWorkspaceStatus, "redirectUri" | "tools">> {
  const env = googleWorkspaceEnv();
  const configured = !!(env.clientId && env.clientSecret);
  const access = await workspaceProviderAccess(db, owner.userId, provider);
  try {
    const row = await loadWorkspaceGrant(db, owner, provider);
    const { error } = await db
      .from("google_workspace_oauth_states")
      .select("id")
      .eq("user_id", owner.userId)
      .filter(...workspaceFilter(owner))
      .eq("provider", provider)
      .limit(1);
    if (error) throw error;
    return {
      configured,
      available: access.read,
      writeAvailable: access.write,
      schemaReady: true,
      connected: !!row,
      writeEnabled: row?.write_enabled === true,
      enabled: row?.enabled !== false,
      requireWriteApproval: row?.require_write_approval === true,
      readOnly: row?.read_only === true,
      grantId: row?.grant_id as string | undefined,
      accountEmail: row?.account_email as string | undefined,
    };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "PGRST205" || code === "42P01")
      return {
        configured,
        available: access.read,
        writeAvailable: access.write,
        schemaReady: false,
        connected: false,
        writeEnabled: false,
        enabled: true,
        requireWriteApproval: false,
        readOnly: false,
      };
    throw error;
  }
}
/** Settings live on the grant row, so they exist only while connected. */
export async function updateWorkspaceSettings(
  db: Db,
  owner: ConnectorOwner,
  provider: GoogleProvider,
  settings: NativeConnectorSettings,
) {
  const patch = connectorSettingsPatch(settings);
  if (!Object.keys(patch).length) return;
  const { data, error } = await db
    .from("user_google_workspace_tokens")
    .update(patch)
    .eq("user_id", owner.userId)
    .filter(...workspaceFilter(owner))
    .eq("provider", provider)
    .select("user_id")
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new GoogleWorkspaceError(
      `Connect ${GOOGLE_PROVIDERS[provider].name} first.`,
    );
}
export async function setWorkspaceToolEnabled(
  db: Db,
  owner: ConnectorOwner,
  provider: GoogleProvider,
  toolName: string,
  enabled: boolean,
) {
  const row = await loadWorkspaceGrant(db, owner, provider);
  if (!row)
    throw new GoogleWorkspaceError(
      `Connect ${GOOGLE_PROVIDERS[provider].name} first.`,
    );
  const next = toggleDisabledTool(
    Array.isArray(row.disabled_tools) ? (row.disabled_tools as string[]) : [],
    toolName,
    enabled,
  );
  const { error } = await db
    .from("user_google_workspace_tokens")
    .update({ disabled_tools: next })
    .eq("user_id", owner.userId)
    .filter(...workspaceFilter(owner))
    .eq("provider", provider)
    .eq("grant_id", row.grant_id);
  if (error) throw error;
}
export async function startWorkspaceOAuth(
  db: Db,
  owner: ConnectorOwner,
  provider: GoogleProvider,
  redirectUri: string,
) {
  // Refused before any state is written: a user the service is not offered
  // to must not be able to start a consent flow for it.
  const access = await assertWorkspaceProviderAvailable(db, owner.userId, provider);
  const env = googleWorkspaceEnv();
  if (!env.clientId || !env.clientSecret)
    throw new ConnectorSetupError(
      googleWorkspaceSetupInstructions(provider, redirectUri),
    );
  const { error: cleanupError } = await db
    .from("google_workspace_oauth_states")
    .delete()
    .eq("user_id", owner.userId)
    .filter(...workspaceFilter(owner))
    .lt("expires_at", new Date().toISOString());
  if (cleanupError) throw cleanupError;
  const state = base64Url(crypto.randomBytes(24));
  const verifier = base64Url(crypto.randomBytes(32));
  const { error } = await db.from("google_workspace_oauth_states").insert({
    user_id: owner.userId,
    org_id: owner.orgId,
    provider,
    state_hash: stateHash(state),
    ...encryptFields("state_config", JSON.stringify({ verifier, redirectUri })),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  if (error) throw error;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: requestedScopes(provider, access).join(" "),
    state,
    code_challenge: base64Url(
      crypto.createHash("sha256").update(verifier).digest(),
    ),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "select_account consent",
  }).toString();
  return { authorizationUrl: url.toString() };
}
function tokenPatch(
  token: Record<string, unknown>,
  provider: GoogleProvider,
  existing?: Record<string, unknown>,
) {
  const scope = token.scope ?? existing?.scope;
  if (
    typeof token.access_token !== "string" ||
    !token.access_token ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  )
    throw new Error("Invalid Google token response");
  const scopes = grantedScopes(scope);
  // Read access is required; write access is optional and recorded as granted.
  if (!GOOGLE_PROVIDERS[provider].read.every((s) => scopes.includes(s)))
    throw new GoogleWorkspaceError(
      "Required Google permissions were not granted. Reconnect and grant the requested access.",
    );
  return {
    ...encryptFields("access_token", token.access_token),
    ...(typeof token.refresh_token === "string" && token.refresh_token
      ? encryptFields("refresh_token", token.refresh_token)
      : {}),
    scope,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    write_enabled: grantedWriteAccess(provider, scope),
  };
}
export async function completeWorkspaceOAuth(
  db: Db,
  completingUserId: string,
  provider: GoogleProvider,
  state: string,
  code: string,
) {
  const { data, error } = await db
    .from("google_workspace_oauth_states")
    .select("*")
    .eq("state_hash", stateHash(state))
    .eq("user_id", completingUserId)
    .eq("provider", provider)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new GoogleWorkspaceError(
      "Authorization expired or was cancelled. Connect again.",
    );
  const config = JSON.parse(decryptFields(data, "state_config")) as {
    verifier: string;
    redirectUri: string;
  };
  const env = googleWorkspaceEnv();
  if (!env.clientId || !env.clientSecret)
    throw new Error("Google OAuth not configured");
  const response = await workspaceRequest(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: env.clientId,
        client_secret: env.clientSecret,
        redirect_uri: config.redirectUri,
        code_verifier: config.verifier,
      }),
    },
  );
  const token = (await response.json()) as Record<string, unknown>;
  if (
    !response.ok ||
    typeof token.refresh_token !== "string" ||
    !token.refresh_token
  )
    throw new GoogleWorkspaceError(
      "Google authorization did not provide offline access. Reconnect.",
    );
  const patch = tokenPatch(token, provider);
  const identityResponse = await workspaceRequest(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  );
  const identity = (await identityResponse.json()) as Record<string, unknown>;
  if (
    !identityResponse.ok ||
    identity.email_verified !== true ||
    typeof identity.email !== "string" ||
    typeof identity.sub !== "string"
  )
    throw new GoogleWorkspaceError(
      "Could not verify the selected Google account. Connect again.",
    );
  const { data: saved, error: saveError } = await db.rpc(
    "complete_google_workspace_oauth",
    {
      p_state_hash: stateHash(state),
      p_provider: provider,
      p_tokens: {
        ...patch,
        account_email: identity.email,
        account_id: identity.sub,
      },
    },
  );
  if (saveError) throw saveError;
  if (!saved)
    throw new GoogleWorkspaceError(
      "Authorization expired or was cancelled. Connect again.",
    );
}
export async function cancelWorkspaceOAuth(
  db: Db,
  owner: ConnectorOwner,
  provider: GoogleProvider,
  state: string,
) {
  const { error } = await db
    .from("google_workspace_oauth_states")
    .delete()
    .eq("user_id", owner.userId)
    .filter(...workspaceFilter(owner))
    .eq("provider", provider)
    .eq("state_hash", stateHash(state));
  if (error) throw error;
}
export async function disconnectWorkspace(
  db: Db,
  owner: ConnectorOwner,
  provider: GoogleProvider,
) {
  // Google revocation affects other grants for the same OAuth client. Remove
  // this local connection only; users can revoke all access in Google settings.
  const { error } = await db.rpc("disconnect_google_workspace", {
    p_user_id: owner.userId,
    p_provider: provider,
    p_org_id: owner.orgId,
  });
  if (error) throw error;
}
export async function workspaceAccessToken(
  db: Db,
  owner: ConnectorOwner,
  provider: GoogleProvider,
): Promise<string> {
  const row = await loadWorkspaceGrant(db, owner, provider);
  if (!row)
    throw new GoogleWorkspaceError(
      "Google connection changed or is disconnected. Reconnect it in Settings → Connectors.",
    );
  if (Date.parse(String(row.expires_at)) - Date.now() > 60_000)
    return decryptFields(row, "access_token");
  const env = googleWorkspaceEnv();
  if (!env.clientId || !env.clientSecret)
    throw new GoogleWorkspaceError("Google OAuth is not configured.");
  const response = await workspaceRequest(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: decryptFields(row, "refresh_token"),
        client_id: env.clientId,
        client_secret: env.clientSecret,
      }),
    },
  );
  const token = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    if (token.error === "invalid_grant") {
      const { error } = await db
        .from("user_google_workspace_tokens")
        .delete()
        .eq("user_id", owner.userId)
        .filter(...workspaceFilter(owner))
        .eq("provider", provider)
        .eq("grant_id", row.grant_id);
      if (error) throw error;
    }
    throw new GoogleWorkspaceError(
      "Google access could not be refreshed. Reconnect this integration.",
    );
  }
  const { data: saved, error } = await db
    .from("user_google_workspace_tokens")
    .update(tokenPatch(token, provider, row))
    .eq("user_id", owner.userId)
    .filter(...workspaceFilter(owner))
    .eq("provider", provider)
    .eq("grant_id", row.grant_id)
    .eq("encrypted_access_token", row.encrypted_access_token)
    .select("user_id")
    .maybeSingle();
  if (error) throw error;
  if (!saved) {
    const current = await loadWorkspaceGrant(db, owner, provider);
    if (
      current &&
      current.grant_id === row.grant_id &&
      Date.parse(String(current?.expires_at)) - Date.now() > 60_000
    )
      return decryptFields(current, "access_token");
    throw new GoogleWorkspaceError(
      "Google connection changed. Please try again.",
    );
  }
  return token.access_token as string;
}
