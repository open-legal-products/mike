/**
 * The two 503 answers whose Sentry event the server side has already filed,
 * and the sentence each shows. The web app and the Word add-in recognise the
 * codes through the same table in packages/client/src/reportedUpstream.ts
 * and show the same sentences; frontend/src/app/lib/reportedUpstreamParity.test.ts
 * keeps the two copies equal.
 *
 * No imports on purpose: that parity test runs under the frontend's vitest,
 * which cannot resolve backend-only packages such as @sentry/node, so the
 * constants must not drag the error helpers or the Sentry client in with them.
 */

/**
 * A dependency this server needs (GoTrue, today) is unreachable: no answer,
 * or a gateway 502/503/504 in front of it. The same code the Next gateway
 * sends when it cannot reach this server, so a client treats both alike:
 * already reported server-side, show "try again shortly", do not report it
 * again.
 */
export const UPSTREAM_UNAVAILABLE_CODE = "upstream_unavailable";
export const UPSTREAM_UNAVAILABLE_MESSAGE =
  "The server is temporarily unreachable. Please try again shortly.";

/** The database is missing an object this build needs: migrations have not run. */
export const SCHEMA_OUT_OF_DATE_CODE = "schema_out_of_date";
export const SCHEMA_OUT_OF_DATE_MESSAGE =
  "The server's database needs an update before this can load. " +
  "Please contact your administrator.";
