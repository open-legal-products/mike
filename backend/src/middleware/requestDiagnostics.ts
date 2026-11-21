import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { withIsolationScope } from "@sentry/node";
import { tagCurrentRequest } from "../lib/observability/sentry";

/** Establish diagnostics before body parsing, auth or domain routing can fail. */
export const requestDiagnostics: RequestHandler = (req, res, next) => {
  // Do not depend on optional HTTP instrumentation for concurrent-request
  // isolation. Async work started by next() retains only this request's scope.
  withIsolationScope(() => {
    // The gateway sends a fresh UUID before contacting us, so pre-header
    // transport failures share correlation with the work already started.
    // This identifier is diagnostic only; it conveys no authorization.
    const incomingId = req.get("x-request-id");
    const requestId = incomingId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incomingId)
      ? incomingId : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    tagCurrentRequest(requestId, req);
    next();
  });
};
