/**
 * The auth sentences live on both sides of the wire: this module owns the
 * `detail` every client receives, and the web app owns the sentence it
 * substitutes per screen (`frontend/src/app/lib/authMessages.ts`). Two
 * tables drift silently — a code added here shows up in the browser as the
 * generic "something went wrong" line, and nobody notices because nothing
 * fails.
 *
 * This test reads the web app's table as text (the backend cannot import
 * the frontend tree) and asserts that every code the backend maps is either
 * handled there or listed below as a deliberate fall-through.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_DETAILS,
  MESSAGE_CODES,
  describeAuthProviderError,
} from "./auth.messages";

const CLIENT_TABLE = resolve(
  __dirname,
  "../../../../frontend/src/app/lib/authMessages.ts",
);

/**
 * Codes the web app deliberately does not re-word. Each is a failure no web
 * screen can reach (phone sign-in, SMS, identity linking) or one whose
 * backend sentence needs no context: `describeError` shows the 4xx `detail`
 * verbatim, which is already the sentence in `CODE_DETAILS`.
 */
const INTENTIONAL_CLIENT_FALLTHROUGH = new Set([
  "identity_already_exists",
  "identity_not_found",
  "mfa_factor_name_conflict",
  "mfa_totp_verify_not_enabled",
  "otp_disabled",
  "over_sms_send_rate_limit",
  "phone_not_confirmed",
  "provider_email_needs_verification",
  "single_identity_not_deletable",
]);

function clientCodes(): Set<string> {
  const source = readFileSync(CLIENT_TABLE, "utf8");
  const start = source.indexOf("export const AUTH_ERROR_MESSAGES");
  const end = source.indexOf("} as const satisfies", start);
  expect(start, "AUTH_ERROR_MESSAGES not found in the web app table").
    toBeGreaterThan(-1);
  expect(end, "AUTH_ERROR_MESSAGES is not terminated as expected").
    toBeGreaterThan(start);
  const table = source.slice(start, end);
  return new Set(
    [...table.matchAll(/^ {4}([a-z0-9_]+):/gm)].map((match) => match[1]!),
  );
}

describe("auth message tables", () => {
  it("gives every backend code a client sentence or an explicit pass", () => {
    const client = clientCodes();
    const mapped = new Set([
      ...Object.keys(CODE_DETAILS),
      ...MESSAGE_CODES.map(([, code]) => code),
    ]);

    const unhandled = [...mapped].filter(
      (code) =>
        !client.has(code) && !INTENTIONAL_CLIENT_FALLTHROUGH.has(code),
    );
    expect(unhandled).toEqual([]);
  });

  it("does not keep fall-through entries for codes the client handles", () => {
    const client = clientCodes();
    const stale = [...INTENTIONAL_CLIENT_FALLTHROUGH].filter((code) =>
      client.has(code),
    );
    expect(stale).toEqual([]);
  });
});

/**
 * Older GoTrue releases send a message and no code. Each pattern below is a
 * guess about text a third party writes, so each one needs a fixture: a
 * pattern that stops matching (or never matched) turns a specific sentence
 * into the route's generic fallback, and only a fixture catches that.
 */
const LEGACY_MESSAGES: ReadonlyArray<[string, string]> = [
  ["Invalid login credentials", "invalid_credentials"],
  ["Email not confirmed", "email_not_confirmed"],
  ["User already registered", "user_already_exists"],
  ["This email has already been registered", "user_already_exists"],
  ["Password should be at least 6 characters", "password_too_short"],
  ["Password cannot be longer than 72 characters", "password_too_long"],
  ["Password is too weak", "weak_password"],
  ["Email rate limit exceeded", "over_request_rate_limit"],
  ["Too many requests, slow down", "over_request_rate_limit"],
  ["Token has expired or is invalid", "otp_expired"],
  [
    "New password should be different from the old password",
    "same_password",
  ],
  ["Invalid TOTP code entered", "mfa_verification_failed"],
  [
    "Unable to validate email address: invalid format",
    "email_address_invalid",
  ],
  ["Signups not allowed for this instance", "signup_disabled"],
];

describe("legacy GoTrue messages", () => {
  it("maps each known message to its code and sentence", () => {
    for (const [message, code] of LEGACY_MESSAGES) {
      const wire = describeAuthProviderError(
        { status: 400, message },
        "fallback",
      );
      expect(wire.code, message).toBe(code);
      expect(wire.detail, message).toBe(CODE_DETAILS[code]);
    }
  });

  it("has a fixture for every pattern", () => {
    for (const [pattern] of MESSAGE_CODES) {
      const matched = LEGACY_MESSAGES.some(([message]) =>
        pattern.test(message),
      );
      expect(matched, `no fixture matches ${pattern}`).toBe(true);
    }
  });
});
