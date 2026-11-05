import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { withIsolationScope } from "@sentry/node";
import { tagCurrentRequest } from "../lib/observability/sentry";

/** Establish diagnostics before body parsing, auth or domain routing can fail. */
export const requestDiagnostics: RequestHandler = (req, res, next) => {
  // Do not depend on optional HTTP instrumentation for concurrent-request
  // isolation. Async work started by next() retains only this request's scope.
  withIsolationScope(() => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    tagCurrentRequest(requestId, req);
    next();
  });
};
