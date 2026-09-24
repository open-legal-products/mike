/**
 * One table of auth failure sentences.
 *
 * Every auth screen used to carry its own `code → sentence` map. Twenty-one
 * codes appeared in two or more of them, and three had drifted: the same
 * `user_not_found`, `same_password` and `signup_disabled` failure read
 * differently depending on which form the user was standing in front of.
 * Sentences are a product surface; they belong in one place.
 *
 * The codes are GoTrue's, normalised by `backend/src/modules/auth/
 * auth.messages.ts`, which also owns the sentence a non-browser client
 * (the Word add-in) receives as `detail`.
 *
 * A screen passes `authMessages({ ... })` when its wording genuinely has to
 * change with the context — "log in again before changing your email" is
 * not the same instruction as "before changing your password" — and the
 * override sits next to the call so the delta is visible.
 */

import {
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
} from "@/app/components/auth/passwordPolicy";

export const TOO_MANY_ATTEMPTS_MESSAGE =
    "Too many attempts. Wait a moment and try again.";

const SESSION_EXPIRED_MESSAGE = "Your session has expired. Log in again.";

export const WEAK_PASSWORD_MESSAGE = `Choose a stronger password: at least ${MIN_PASSWORD_LENGTH} characters, mixing letters, numbers, and symbols.`;

export const PASSWORD_LENGTH_MESSAGE = `Password must have at least ${MIN_PASSWORD_LENGTH} characters and use at most ${MAX_PASSWORD_LENGTH} UTF-8 bytes.`;

/** Wording for a link that has been used, tampered with, or has expired. */
export const LINK_SPENT_MESSAGE =
    "This confirmation link is invalid or has expired. Request a new one.";

/** Wording for a six-digit authenticator code, shared by every MFA screen. */
export const MFA_CODE_INCORRECT_MESSAGE =
    "That code is incorrect. Enter the current six-digit code from your authenticator app.";
const MFA_CODE_EXPIRED_MESSAGE =
    "That code expired. Enter the current six-digit code from your authenticator app.";

export const AUTH_ERROR_MESSAGES = {
    // Credentials
    invalid_credentials: "The email or password is incorrect.",
    // GoTrue reports a missing account as a dead session, not as "no such
    // user"; the login screen deliberately says something else (see there).
    user_not_found: SESSION_EXPIRED_MESSAGE,
    email_not_confirmed:
        "Confirm your email address before logging in. Check your inbox for the confirmation link.",
    user_banned: "This account is locked. Contact support to have it unlocked.",

    // Account creation
    user_already_exists:
        "An account with this email already exists. Log in instead.",
    email_exists: "An account with this email already exists. Log in instead.",
    signup_disabled: "New accounts aren't open right now.",
    email_address_invalid: "Enter a valid email address.",
    email_address_not_authorized:
        "Mike can't send email to this address. Use a different one.",

    // Passwords
    weak_password: WEAK_PASSWORD_MESSAGE,
    same_password: "Choose a password you haven't used on Mike before.",
    password_too_short: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    password_too_long: `Password must be at most ${MAX_PASSWORD_LENGTH} UTF-8 bytes. Accented characters and emoji can use more than one byte.`,

    // Input this form can fix
    validation_failed: "Some of the information provided isn't valid.",
    invalid_request: "Some of the information provided isn't valid.",

    // Sessions and step-up
    session_expired: SESSION_EXPIRED_MESSAGE,
    session_not_found: SESSION_EXPIRED_MESSAGE,
    cookie_session_required: SESSION_EXPIRED_MESSAGE,
    bad_jwt: SESSION_EXPIRED_MESSAGE,
    no_authorization: SESSION_EXPIRED_MESSAGE,
    refresh_token_not_found: SESSION_EXPIRED_MESSAGE,
    refresh_token_already_used: SESSION_EXPIRED_MESSAGE,
    reauthentication_needed: "Log in again to make this change.",
    reauthentication_not_valid: MFA_CODE_INCORRECT_MESSAGE,
    insufficient_aal: "Finish two-factor verification to continue.",

    // Authenticator apps
    mfa_verification_failed: MFA_CODE_INCORRECT_MESSAGE,
    mfa_verification_rejected:
        "That code was rejected. Enter the current six-digit code from your authenticator app.",
    mfa_challenge_expired: MFA_CODE_EXPIRED_MESSAGE,
    mfa_factor_not_found: "This authenticator is no longer registered.",
    mfa_ip_address_mismatch:
        "Your network changed mid-verification. Start again from the login page.",
    too_many_enrolled_mfa_factors:
        "You already have the maximum number of authenticators. Remove one first.",
    mfa_totp_enroll_not_enabled:
        "Authenticator apps are turned off for this workspace.",

    // Links and one-time codes
    otp_expired: "This link or code has expired. Request a new one.",
    flow_state_expired: LINK_SPENT_MESSAGE,
    flow_state_not_found: LINK_SPENT_MESSAGE,
    bad_code_verifier:
        "This link was opened in a different browser than the one that started sign-in. Start again from the login page.",
    bad_oauth_state:
        "Sign-in couldn't be completed. Start again from the login page.",
    bad_oauth_callback:
        "Sign-in couldn't be completed. Start again from the login page.",

    // Sign-in methods
    email_provider_disabled:
        "Password login is turned off. Continue with Google or SSO instead.",
    provider_disabled:
        "That sign-in method is turned off for this workspace. Use your email and password instead.",
    oauth_provider_not_supported:
        "That sign-in method is turned off for this workspace. Use your email and password instead.",
    sso_disabled: "Single sign-on is not enabled.",
    sso_domain_not_allowed:
        "Single sign-on is not available for this email domain.",
    sso_unavailable: "Unable to start single sign-on for this email domain.",
    sso_provider_not_found:
        "Single sign-on is not set up for this email domain.",
    saml_provider_disabled:
        "Single sign-on is not enabled for this email domain.",

    // Throttling and checks
    over_request_rate_limit: TOO_MANY_ATTEMPTS_MESSAGE,
    over_email_send_rate_limit:
        "Too many emails have been sent to this address. Wait a few minutes and try again.",
    captcha_failed:
        "The security check didn't pass. Reload the page and try again.",
    request_timeout: "The request timed out. Try again.",
} as const satisfies Record<string, string>;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

/**
 * The shared table with this screen's deltas applied. Overrides are typed
 * loosely on purpose: a screen may add a code only its own route emits.
 */
export function authMessages(
    overrides: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
    return { ...AUTH_ERROR_MESSAGES, ...overrides };
}
