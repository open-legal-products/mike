// Business logic for the auth module.
//
// Service layer behind auth.routes.ts. This module owns the request-payload
// schemas, the redirect-URL construction, and every GoTrue call the endpoints
// make. It never touches req/res: the cookie-bearing Supabase client is
// created by the route (that needs req/res to read and write cookies) and
// handed in, and every function returns GoTrue's own `{ data, error }` shape
// so the route keeps mapping failures exactly as it always has.
//
// Auth talks to Supabase GoTrue, not to the application database. First-run
// setup uses the service-role client (`db: Db`) only for GoTrue's admin API.
// The cookie/session primitives themselves stay in lib/authSession and
// lib/authHandoff because middleware/auth depends on them.

import { z } from "zod";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_LONG_DETAIL,
} from "./auth.messages";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { consumeAuthHandoff, issueAuthHandoff } from "../../lib/authHandoff";
import type { Db } from "../../lib/supabase";
import { supabaseSessionConfiguration } from "../../lib/runtimeConfig";
import { ssoConfiguration } from "../../lib/ssoConfig";

// ---------------------------------------------------------------------------
// Request payload schemas
// ---------------------------------------------------------------------------

export const emailSchema = z.string().trim().email().max(320);

/**
 * The 72 is bcrypt's limit on its INPUT IN BYTES, not in characters. A
 * `.max(72)` here counts UTF-16 code units, so a 60-character passphrase
 * with accents or an emoji passes this check and is then rejected by
 * GoTrue — the failure a user cannot explain. The clients count the same
 * bytes (`isPasswordTooLong` in frontend/src/app/components/auth/
 * passwordPolicy.ts), so both sides agree on which passwords are legal.
 *
 * The character cap that remains is only a work bound: anything that hits
 * it is over the byte limit too, and gets the same sentence.
 */
const PASSWORD_CHARACTER_GUARD = 1024;

function passwordField(minimumCharacters: number) {
  return z
    .string()
    .min(minimumCharacters)
    .max(PASSWORD_CHARACTER_GUARD)
    .superRefine((value, ctx) => {
      if (Buffer.byteLength(value, "utf8") <= PASSWORD_MAX_LENGTH) return;
      ctx.addIssue({
        code: "too_big",
        origin: "string",
        maximum: PASSWORD_MAX_LENGTH,
        inclusive: true,
        message: PASSWORD_TOO_LONG_DETAIL,
      });
    });
}

/**
 * Sign-in validates presence only. The policy (10 characters, 72 bytes)
 * governs passwords we are about to SET; an existing account may hold one
 * set under main's earlier 8-character rule, by an admin, or before GoTrue
 * refused >72 bytes (bcrypt compares only the first 72, so it still
 * matches). Rejecting those here would lock their owners out with a
 * message telling them to change a password they cannot reach. GoTrue is
 * the only judge of a match; the 4096 cap is just a request-size bound.
 */
export const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(4096),
});
/** Sign-up applies the length policy; login accepts whatever was set. */
export const signupSchema = credentialsSchema.extend({
  password: passwordField(PASSWORD_MIN_LENGTH),
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
  password: passwordField(PASSWORD_MIN_LENGTH),
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

export const ssoRequestSchema = z.object({
  provider: z.literal("sso"),
  email: z.string().trim().toLowerCase().email().max(320),
});

export function startSsoSignIn(
  client: SupabaseClient,
  domain: string,
  redirectTo: string,
) {
  return client.auth.signInWithSSO({
    domain,
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

// ---------------------------------------------------------------------------
// Sign-in options and first-run setup
// ---------------------------------------------------------------------------

/**
 * First-run setup is offered only where the deployment asks for it
 * (backend/scripts/vercel-start.sh sets MIKE_FIRST_RUN_SETUP=true): an
 * install that creates its accounts some other way never exposes it.
 */
export function firstRunSetupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIKE_FIRST_RUN_SETUP?.trim().toLowerCase() === "true";
}

/**
 * Whether people can sign up with email and password. A deployment that
 * uses first-run setup starts on a Supabase project that cannot send them a
 * working confirmation email (no Site URL for this deployment, and a mailer
 * that delivers only to the project's own team), so sign-up stays closed
 * there until the operator configures email and sets
 * MIKE_SIGNUP_EMAIL_CONFIGURED=true (docs/vercel.md). Every other install is
 * unchanged.
 */
export function emailSignupOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!firstRunSetupEnabled(env)) return true;
  return env.MIKE_SIGNUP_EMAIL_CONFIGURED?.trim().toLowerCase() === "true";
}

/** The sentence a would-be user sees while sign-up is closed. */
export const SIGNUP_EMAIL_NOT_CONFIGURED_DETAIL =
  "Sign-up isn't open on this Mike deployment yet, because it can't send " +
  "confirmation emails. Ask the person who set it up to configure email, or " +
  "log in if you already have an account.";

const PROVIDER_SETTINGS_TTL_MS = 60_000;
let cachedGoogleEnabled: { value: boolean; expiresAt: number } | undefined;

/**
 * Whether Supabase Auth has the Google provider switched on, from GoTrue's
 * public settings endpoint. Cached for a minute. When the answer cannot be
 * read the button stays visible, as it always was, rather than hiding a
 * provider that may well work.
 */
async function googleSignInEnabled(fetchImpl: typeof fetch): Promise<boolean> {
  const now = Date.now();
  if (cachedGoogleEnabled && cachedGoogleEnabled.expiresAt > now) {
    return cachedGoogleEnabled.value;
  }
  let value = true;
  try {
    const { url, key } = supabaseSessionConfiguration();
    const response = await fetchImpl(`${url.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const settings = (await response.json()) as { external?: { google?: unknown } };
      value = settings.external?.google === true;
    }
  } catch {
    // Unknown: keep the button (see above).
  }
  cachedGoogleEnabled = { value, expiresAt: now + PROVIDER_SETTINGS_TTL_MS };
  return value;
}

/** Test seam: forget the cached provider settings. */
export function resetSignInOptionsCache(): void {
  cachedGoogleEnabled = undefined;
}

export type SignInOptions = {
  google: boolean;
  sso: boolean;
  setupRequired: boolean;
  /** False while email sign-up cannot work (see emailSignupOpen). */
  signup: boolean;
};

/** Which sign-in routes the login page should offer, and whether this instance still needs its first account. */
export async function signInOptions(
  db: Db,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInOptions> {
  const [google, setupRequired] = await Promise.all([
    googleSignInEnabled(fetchImpl),
    instanceSetupAvailable(db),
  ]);
  return {
    google,
    sso: ssoConfiguration().enabled,
    setupRequired,
    signup: emailSignupOpen(),
  };
}

/** True while first-run setup is enabled and nobody has an account yet. */
export async function instanceSetupAvailable(db: Db): Promise<boolean> {
  if (!firstRunSetupEnabled()) return false;
  return !(await instanceHasAccounts(db));
}

/** Asks GoTrue for at most one user: any answer at all means setup is done. */
async function instanceHasAccounts(db: Db): Promise<boolean> {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw error;
  return data.users.length > 0;
}

export type FirstAccountResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "taken" }
  | { ok: false; reason: "auth_error"; error: unknown };

/**
 * Create the instance's first account, confirmed, through the Auth admin
 * API. A Marketplace Supabase project cannot email a confirmation link to
 * anyone outside its own team, so this one account is confirmed directly;
 * every later sign-up goes through the normal confirmation email.
 *
 * Offered only while the instance has no account. Two requests arriving in
 * the same instant on a brand-new deployment could both pass that check and
 * each create an account. That is accepted: the first account has no
 * special rights, and closing the gap would need a database claim that
 * every Mike deployment would carry for a one-time Vercel step.
 */
export async function createFirstAccount(
  db: Db,
  credentials: Credentials,
): Promise<FirstAccountResult> {
  if (!firstRunSetupEnabled()) return { ok: false, reason: "unavailable" };
  if (await instanceHasAccounts(db)) return { ok: false, reason: "taken" };

  const { error } = await db.auth.admin.createUser({
    email: credentials.email,
    password: credentials.password,
    email_confirm: true,
  });
  if (error) return { ok: false, reason: "auth_error", error };
  return { ok: true };
}
