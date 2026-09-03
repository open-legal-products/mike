// Business logic for the auth module.
//
// Service layer behind auth.routes.ts. This module owns the request-payload
// schemas, the redirect-URL construction, and every GoTrue call the endpoints
// make. It never touches req/res: the cookie-bearing Supabase client is
// created by the route (that needs req/res to read and write cookies) and
// handed in, and every function returns GoTrue's own `{ data, error }` shape
// so the route keeps mapping failures exactly as it always has.
//
// There is no `db: Db` here — auth talks to Supabase GoTrue, not to the
// application database. The cookie/session primitives themselves stay in
// lib/authSession and lib/authHandoff because middleware/auth depends on them.

import { z } from "zod";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { consumeAuthHandoff, issueAuthHandoff } from "../../lib/authHandoff";

// ---------------------------------------------------------------------------
// Request payload schemas
// ---------------------------------------------------------------------------

export const emailSchema = z.string().trim().email().max(320);
export const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(4096),
});
export const handoffRequestIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const exchangeSchema = z.object({
  code: z.string().trim().min(1).max(4096),
  handoffRequestId: handoffRequestIdSchema.optional(),
});
export const handoffSchema = z.object({
  ticket: z
    .string()
    .trim()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  requestId: handoffRequestIdSchema,
});
export const passwordSchema = z.object({
  password: z.string().min(8).max(4096),
  signOut: z.boolean().optional(),
});
export const factorSchema = z.object({ factorId: z.string().uuid() });
export const verificationSchema = factorSchema.extend({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  challengeId: z.string().uuid().optional(),
});
export const friendlyNameSchema = z.string().trim().min(1).max(100);

export type Credentials = z.infer<typeof credentialsSchema>;

// ---------------------------------------------------------------------------
// Redirect targets
// ---------------------------------------------------------------------------

/**
 * Only same-site absolute paths survive; anything else falls back. Blocks
 * protocol-relative (`//evil`), backslash, and control-character payloads
 * from riding along as an open redirect.
 */
export function safeNext(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  if (
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fallback;
  }
  return value;
}

/** The email/OAuth callback URL for a request that arrived from `origin`. */
export function buildCallbackUrl(
  origin: string,
  next: unknown,
  fallback: string,
  path = "/auth/callback",
): string {
  const url = new URL(path, origin);
  url.searchParams.set("next", safeNext(next, fallback));
  return url.toString();
}

// ---------------------------------------------------------------------------
// GoTrue calls
// ---------------------------------------------------------------------------

export function signInWithPassword(
  client: SupabaseClient,
  credentials: Credentials,
) {
  return client.auth.signInWithPassword(credentials);
}

export function signUpWithPassword(
  client: SupabaseClient,
  credentials: Credentials,
  emailRedirectTo: string,
) {
  return client.auth.signUp({
    ...credentials,
    options: { emailRedirectTo },
  });
}

export function startGoogleOAuth(client: SupabaseClient, redirectTo: string) {
  return client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });
}

export function exchangeCodeForSession(client: SupabaseClient, code: string) {
  return client.auth.exchangeCodeForSession(code);
}

/** Mint a one-shot ticket the Word add-in trades for a cookie session. */
export function issueWordHandoff(args: {
  userId: string;
  requestId: string;
  origin: string;
  session: Session;
}) {
  return issueAuthHandoff(args);
}

/** Redeem that ticket. Returns null when it is unknown, used, or expired. */
export function consumeWordHandoff(args: {
  ticket: string;
  requestId: string;
  origin: string;
}) {
  return consumeAuthHandoff(args);
}

export function applyHandoffSession(
  client: SupabaseClient,
  tokens: { accessToken: string; refreshToken: string },
) {
  return client.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
}

export function sendPasswordReset(
  client: SupabaseClient,
  email: string,
  redirectTo: string,
) {
  return client.auth.resetPasswordForEmail(email, { redirectTo });
}

export async function currentUser(
  client: SupabaseClient,
): Promise<{ user: User | null; error: unknown }> {
  const { data, error } = await client.auth.getUser();
  return { user: data.user, error };
}

export function signOut(client: SupabaseClient, scope: "global" | "local") {
  return client.auth.signOut({ scope });
}

export function updateEmail(
  client: SupabaseClient,
  email: string,
  emailRedirectTo: string,
) {
  return client.auth.updateUser({ email }, { emailRedirectTo });
}

export function updatePassword(client: SupabaseClient, password: string) {
  return client.auth.updateUser({ password });
}

export function listMfaFactors(client: SupabaseClient) {
  return client.auth.mfa.listFactors();
}

export function mfaAssuranceLevel(client: SupabaseClient) {
  return client.auth.mfa.getAuthenticatorAssuranceLevel();
}

export function enrollMfaFactor(
  client: SupabaseClient,
  friendlyName: string,
) {
  return client.auth.mfa.enroll({ factorType: "totp", friendlyName });
}

export function challengeMfaFactor(
  client: SupabaseClient,
  args: { factorId: string },
) {
  return client.auth.mfa.challenge(args);
}

export function verifyMfaChallenge(
  client: SupabaseClient,
  args: { factorId: string; challengeId: string; code: string },
) {
  return client.auth.mfa.verify(args);
}

export function challengeAndVerifyMfa(
  client: SupabaseClient,
  args: { factorId: string; code: string },
) {
  return client.auth.mfa.challengeAndVerify(args);
}

export function unenrollMfaFactor(
  client: SupabaseClient,
  args: { factorId: string },
) {
  return client.auth.mfa.unenroll(args);
}
