/**
 * Translate GoTrue (Supabase Auth) failures into the wire contract the
 * clients render verbatim: `{ status, code, detail }`.
 *
 * GoTrue's own messages are written for developers ("Password should
 * contain at least one character of each: abcdefghijklmnopqrstuvwxyz..."),
 * change between releases, and occasionally carry internals. The backend
 * owns the user-facing `detail`, so every client (web, Word add-in) shows
 * the same concise, accurate sentence without re-implementing this table.
 *
 * Unknown 4xx codes fall back to the route's own generic line rather than
 * the raw provider text; unknown statuses become a 500.
 */

export interface AuthProviderErrorLike {
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

export interface AuthWireError {
  status: number;
  code: string | null;
  detail: string;
}

/** Matches the web app's `MIN_PASSWORD_LENGTH` so the API cannot be used to
 *  bypass the rule the sign-up form enforces. */
export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt's input limit; GoTrue rejects longer passwords. */
export const PASSWORD_MAX_LENGTH = 72;

export const PASSWORD_TOO_SHORT_DETAIL = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
export const PASSWORD_TOO_LONG_DETAIL = `Password must be at most ${PASSWORD_MAX_LENGTH} UTF-8 bytes. Accented characters and emoji can use more than one byte.`;

const SESSION_EXPIRED_DETAIL = "Your session has expired. Sign in again to continue.";
const TOO_MANY_ATTEMPTS_DETAIL =
  "Too many attempts. Wait a few minutes and try again.";

/** GoTrue error codes → what the user should read. */
export const CODE_DETAILS: Readonly<Record<string, string>> = {
  invalid_credentials: "The email or password is incorrect.",
  email_not_confirmed:
    "Confirm your email address before signing in. Check your inbox for the confirmation link.",
  phone_not_confirmed: "Confirm your phone number before signing in.",
  user_already_exists:
    "An account with this email already exists. Sign in instead.",
  email_exists: "An account with this email already exists. Sign in instead.",
  weak_password: `This password is too weak. Use at least ${PASSWORD_MIN_LENGTH} characters with a mix of letters, numbers and symbols.`,
  password_too_short: PASSWORD_TOO_SHORT_DETAIL,
  password_too_long: PASSWORD_TOO_LONG_DETAIL,
  same_password: "The new password must be different from your current one.",
  email_address_invalid: "Enter a valid email address.",
  email_address_not_authorized:
    "This email address can't be used to sign up. Contact support if you think this is a mistake.",
  signup_disabled: "New sign-ups are currently disabled.",
  user_banned: "This account has been suspended. Contact support for help.",
  over_email_send_rate_limit:
    "Too many emails were sent to this address. Wait a few minutes and try again.",
  over_sms_send_rate_limit: TOO_MANY_ATTEMPTS_DETAIL,
  over_request_rate_limit: TOO_MANY_ATTEMPTS_DETAIL,
  otp_expired: "This link or code has expired. Request a new one.",
  otp_disabled: "This sign-in method is not available.",
  flow_state_expired: "This sign-in attempt expired. Start again.",
  flow_state_not_found: "This sign-in attempt is no longer valid. Start again.",
  bad_code_verifier: "This sign-in attempt is no longer valid. Start again.",
  session_expired: SESSION_EXPIRED_DETAIL,
  session_not_found: SESSION_EXPIRED_DETAIL,
  refresh_token_not_found: SESSION_EXPIRED_DETAIL,
  refresh_token_already_used: SESSION_EXPIRED_DETAIL,
  bad_jwt: SESSION_EXPIRED_DETAIL,
  no_authorization: SESSION_EXPIRED_DETAIL,
  user_not_found: SESSION_EXPIRED_DETAIL,
  reauthentication_needed: "Sign in again to make this change.",
  reauthentication_not_valid: "The verification code is invalid or expired.",
  insufficient_aal: "Verify with your authenticator app to continue.",
  mfa_verification_failed: "The verification code is invalid or expired.",
  mfa_verification_rejected: "The verification code was rejected. Try again.",
  mfa_challenge_expired: "The verification challenge expired. Try again.",
  mfa_factor_name_conflict: "An authenticator with that name already exists.",
  mfa_factor_not_found: "That authenticator was not found.",
  mfa_totp_enroll_not_enabled: "Authenticator apps are not enabled.",
  mfa_totp_verify_not_enabled: "Authenticator apps are not enabled.",
  too_many_enrolled_mfa_factors:
    "You have reached the maximum number of authenticators. Remove one first.",
  provider_disabled: "This sign-in method is not enabled.",
  provider_email_needs_verification:
    "Verify the email address on your sign-in provider first.",
  identity_already_exists: "That sign-in method is already linked to another account.",
  identity_not_found: "That sign-in method is not linked to this account.",
  single_identity_not_deletable:
    "You can't remove your only sign-in method.",
  captcha_failed: "The security check failed. Try again.",
  validation_failed: "Some of the information provided isn't valid.",
};

/**
 * Older GoTrue releases send only a message. Recognise the common ones so
 * they receive the same treatment as coded errors.
 */
export const MESSAGE_CODES: ReadonlyArray<[RegExp, string]> = [
  [/invalid login credentials/i, "invalid_credentials"],
  [/email not confirmed/i, "email_not_confirmed"],
  [/user already registered/i, "user_already_exists"],
  [/already been registered/i, "user_already_exists"],
  [/password should be at least/i, "password_too_short"],
  [/cannot be longer than 72/i, "password_too_long"],
  [/password .*too (weak|short)/i, "weak_password"],
  [/rate limit exceeded/i, "over_request_rate_limit"],
  [/too many requests/i, "over_request_rate_limit"],
  [/token has expired|otp expired|expired or invalid/i, "otp_expired"],
  [/new password should be different/i, "same_password"],
  [/invalid totp code|invalid code/i, "mfa_verification_failed"],
  [/unable to validate email|invalid email/i, "email_address_invalid"],
  [/signups not allowed/i, "signup_disabled"],
];

function normalizeCode(code: string | null, message: string | null): string | null {
  if (code === "validation_failed" && message) {
    if (/72 characters/i.test(message)) return "password_too_long";
    if (/password/i.test(message) && /at least/i.test(message)) {
      return "password_too_short";
    }
    if (/email/i.test(message)) return "email_address_invalid";
  }
  if (code) return code;
  if (!message) return null;
  for (const [pattern, mapped] of MESSAGE_CODES) {
    if (pattern.test(message)) return mapped;
  }
  return null;
}

/**
 * Decide what a provider failure looks like on the wire.
 *
 * - 4xx with a recognised code: our sentence for that code.
 * - 4xx with an unknown code: the route's fallback (never provider text).
 * - anything else: 500 with the fallback; the caller logs the original.
 */
export function describeAuthProviderError(
  error: unknown,
  fallback: string,
): AuthWireError {
  const candidate = (error ?? {}) as AuthProviderErrorLike;
  const status =
    typeof candidate.status === "number" && Number.isFinite(candidate.status)
      ? candidate.status
      : null;
  const rawCode = typeof candidate.code === "string" && candidate.code ? candidate.code : null;
  const message =
    typeof candidate.message === "string" && candidate.message
      ? candidate.message
      : null;

  if (status === null || status < 400 || status >= 500) {
    return { status: 500, code: null, detail: fallback };
  }

  const code = normalizeCode(rawCode, message);
  const detail = (code && CODE_DETAILS[code]) || fallback;
  return { status, code, detail };
}

/**
 * Turn a zod issue list from the credentials/password schemas into a
 * specific message when the problem is something the user can fix.
 */
export function describeAuthValidationIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; code: string; message?: string }>,
): { code: string; detail: string } {
  for (const issue of issues) {
    const field = issue.path[0];
    if (field === "password") {
      if (issue.code === "too_small") {
        return { code: "password_too_short", detail: PASSWORD_TOO_SHORT_DETAIL };
      }
      if (issue.code === "too_big") {
        return { code: "password_too_long", detail: PASSWORD_TOO_LONG_DETAIL };
      }
    }
    if (field === "email") {
      return { code: "email_address_invalid", detail: "Enter a valid email address." };
    }
  }
  return {
    code: "invalid_request",
    detail: "The authentication request is invalid.",
  };
}
