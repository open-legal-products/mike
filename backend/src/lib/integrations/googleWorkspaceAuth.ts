import type {
  GoogleWorkspaceProvider,
  GoogleWorkspaceStatus,
} from "@mike/contracts";
import crypto from "node:crypto";
import type { Db } from "../supabase";
import {
  base64Url,
  encryptString,
  decryptString,
  stateHash,
} from "../mcp/client";
import { googleDriveOAuthEnv } from "./googleDrive";
import { googleDriveRequest } from "./googleDriveHttp";

export type GoogleProvider = GoogleWorkspaceProvider;
export const GOOGLE_PROVIDERS = {
  gmail: {
    name: "Gmail",
    read: ["https://www.googleapis.com/auth/gmail.readonly"],
    write: ["https://www.googleapis.com/auth/gmail.modify"],
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
export function requiredScopes(
  provider: GoogleProvider,
  write: boolean,
): string[] {
  const config = GOOGLE_PROVIDERS[provider];
  return ["openid", "email", ...config.read, ...(write ? config.write : [])];
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
  userId: string,
  provider: GoogleProvider,
) {
  const { data, error } = await db
    .from("user_google_workspace_tokens")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}
export async function workspaceStatus(
  db: Db,
  userId: string,
  provider: GoogleProvider,
): Promise<Omit<GoogleWorkspaceStatus, "redirectUri">> {
  const env = googleWorkspaceEnv();
  const configured = !!(env.clientId && env.clientSecret);
  try {
    const row = await loadWorkspaceGrant(db, userId, provider);
    const { error } = await db
      .from("google_workspace_oauth_states")
      .select("id")
      .eq("user_id", userId)
      .eq("provider", provider)
      .limit(1);
    if (error) throw error;
    return {
      configured,
      schemaReady: true,
      connected: !!row,
      writeEnabled: row?.write_enabled === true,
      grantId: row?.grant_id as string | undefined,
      accountEmail: row?.account_email as string | undefined,
    };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "PGRST205" || code === "42P01")
      return {
        configured,
        schemaReady: false,
        connected: false,
        writeEnabled: false,
      };
    throw error;
  }
}
export async function startWorkspaceOAuth(
  db: Db,
  userId: string,
  provider: GoogleProvider,
  redirectUri: string,
  write = false,
) {
  const env = googleWorkspaceEnv();
  if (!env.clientId || !env.clientSecret)
    throw new GoogleWorkspaceError(
      "Configure a Google OAuth client on this server first.",
    );
  const { error: cleanupError } = await db
    .from("google_workspace_oauth_states")
    .delete()
    .eq("user_id", userId)
    .lt("expires_at", new Date().toISOString());
  if (cleanupError) throw cleanupError;
  const state = base64Url(crypto.randomBytes(24));
  const verifier = base64Url(crypto.randomBytes(32));
  const { error } = await db.from("google_workspace_oauth_states").insert({
    user_id: userId,
    provider,
    state_hash: stateHash(state),
    ...encryptFields("state_config", JSON.stringify({ verifier, redirectUri })),
    write_enabled: write,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  if (error) throw error;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: requiredScopes(provider, write).join(" "),
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
  write: boolean,
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
  const scopes = typeof scope === "string" ? scope.split(/\s+/) : [];
  if (
    !requiredScopes(provider, write)
      .filter((s) => s !== "openid" && s !== "email")
      .every(
        (s) =>
          scopes.includes(s) ||
          (s.endsWith("/gmail.readonly") &&
            scopes.includes("https://www.googleapis.com/auth/gmail.modify")) ||
          (s.endsWith("/calendar.events.readonly") &&
            scopes.includes("https://www.googleapis.com/auth/calendar.events")),
      )
  )
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
  const patch = tokenPatch(token, provider, data.write_enabled === true);
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
  userId: string,
  provider: GoogleProvider,
  state: string,
) {
  const { error } = await db
    .from("google_workspace_oauth_states")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("state_hash", stateHash(state));
  if (error) throw error;
}
export async function disconnectWorkspace(
  db: Db,
  userId: string,
  provider: GoogleProvider,
) {
  // Google revocation affects other grants for the same OAuth client. Remove
  // this local connection only; users can revoke all access in Google settings.
  const { error } = await db.rpc("disconnect_google_workspace", {
    p_user_id: userId,
    p_provider: provider,
  });
  if (error) throw error;
}
export async function workspaceAccessToken(
  db: Db,
  userId: string,
  provider: GoogleProvider,
  requiredGrant?: string,
): Promise<string> {
  const row = await loadWorkspaceGrant(db, userId, provider);
  if (
    !row ||
    (requiredGrant &&
      (row.grant_id !== requiredGrant || row.write_enabled !== true))
  )
    throw new GoogleWorkspaceError(
      "Google connection changed or is disconnected. Reconnect and request a new action.",
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
        .eq("user_id", userId)
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
    .update(tokenPatch(token, provider, row.write_enabled === true, row))
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("grant_id", row.grant_id)
    .eq("encrypted_access_token", row.encrypted_access_token)
    .select("user_id")
    .maybeSingle();
  if (error) throw error;
  if (!saved) {
    const current = await loadWorkspaceGrant(db, userId, provider);
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
