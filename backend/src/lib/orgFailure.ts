// HTTP mapping for lib/orgs.ts failures.
//
// Lives in lib/ rather than inside the orgs module because two routers need
// it: modules/orgs/orgs.routes.ts and modules/user/user.routes.ts (the
// /user/invitations endpoints). A module facade must never write to `res`, so
// the mapping sits beside lib/serviceResult.ts, which takes an express
// Response for the same reason.

import { type Response } from "express";
import { sendInternalError } from "./httpError";
import { type OrgResult } from "./orgs";

// Map the service's discriminated failure kinds onto HTTP responses. Kept in
// one place so every handler reports errors consistently.
//
// The split that matters here is between failures the caller CAUSED and
// failures the caller merely OBSERVED. The first six kinds are the service
// deliberately saying no, and their text is written for the person reading
// it. `db_error` is not a verdict at all — it is whatever Postgres said —
// and it goes out through sendInternalError so the client gets the generic
// message and the details stay in the server log.
export function sendOrgFailure(
    res: Response,
    result: Extract<OrgResult<unknown>, { ok: false }>,
) {
    switch (result.kind) {
        case "validation":
            return void res.status(400).json({ detail: result.detail });
        case "forbidden":
            return void res.status(403).json({
                detail: "Only an organization admin can do that.",
            });
        case "not_found":
            return void res
                .status(404)
                .json({ detail: "Organization not found" });
        case "conflict":
            return void res.status(409).json({ detail: result.detail });
        case "last_admin":
            return void res.status(409).json({
                detail: "An organization must keep at least one admin.",
            });
        case "expired":
            // 410 Gone: the invitation existed and is no longer actionable,
            // which is a different story from "never heard of it" (404).
            return void res
                .status(410)
                .json({ detail: "That invitation has expired." });
        case "db_error":
            // `result.detail` is a raw Postgres message: it can name tables,
            // columns, constraints and index definitions, and quote the
            // offending row — which in the org tables means somebody's email
            // address. sendInternalError logs it (with the request id, so
            // support can correlate) and answers with the generic body.
            return void sendInternalError(res, new Error(result.detail));
    }
}
