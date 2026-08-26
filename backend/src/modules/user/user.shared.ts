// Shared types + helpers for the user module service layer.
//
// The user service is split by concern across sibling files
// (user.profile.ts, user.mfa.ts, user.apiKeys.ts, user.mcp.ts,
// user.account.ts, user.export.ts). Anything used by more than one of them
// lives here, and user.service.ts re-exports the whole public surface so
// route/test importers see a single module.

import { createServerSupabase } from "../../lib/supabase";

export type Db = ReturnType<typeof createServerSupabase>;

// Every caller sends this straight to the browser as `{ ok: false, detail }`.
// PostgREST errors are plain objects rather than Errors, so their
// message/details/hint/code are still joined — but an unrecognised value now
// falls back to a generic message instead of JSON.stringify()ing the whole
// object, which could dump request context (including secrets) to the client.
export function errorMessage(error: unknown): string {
    if (error && typeof error === "object" && !(error instanceof Error)) {
        const record = error as {
            message?: unknown;
            details?: unknown;
            hint?: unknown;
            code?: unknown;
        };
        const composed = [
            record.message,
            record.details,
            record.hint,
            record.code,
        ]
            .filter(
                (value): value is string =>
                    typeof value === "string" && !!value,
            )
            .join(" ");
        if (composed) return composed;
    }
    if (error instanceof Error && error.message) return error.message;
    return typeof error === "string" && error ? error : "Unexpected error";
}
