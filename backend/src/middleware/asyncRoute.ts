// Shared plumbing for async Express handlers.
//
// An `async` handler that rejects has to reach an error middleware, or the
// request hangs until the client or the proxy times out and nothing is logged.
// Express 5 forwards a rejected handler promise to `next(err)` by itself, so
// this wrapper is no longer what keeps the socket from hanging — but it is
// still the single place where that contract is stated, and it pins the request
// type: a bare `Request` defaults to `ParamsDictionary`, where `req.params.x` is
// `string | string[]` and every handler has to narrow by hand.
// `Request<ParamsFlatDictionary>` is the shape a path-parameter route actually
// produces.
//
// Four module routers (workflows, workflow add-ons, quick actions, uploads)
// each carried a private copy of this wrapper; this is that one copy, and the
// routers that had none now use it too, so the convention is visible in every
// routes file instead of four of nineteen.

import type { NextFunction, Request, Response } from "express";
import type { ParamsFlatDictionary } from "express-serve-static-core";
import { handleUnhandledError } from "./internalErrorResponse";

export type AsyncRoute = (
  req: Request<ParamsFlatDictionary>,
  res: Response,
) => Promise<unknown>;

export function asyncRoute(handler: AsyncRoute) {
  return (
    req: Request<ParamsFlatDictionary>,
    res: Response,
    next: NextFunction,
  ) => {
    void handler(req, res).catch(next);
  };
}

// Builds a router-scoped error middleware. Express identifies error middleware
// purely by arity, so all four parameters must stay declared even when a router
// does not use them.
//
// Its only job is to attribute the failure to a router in the logs; the
// response itself is delegated to the same app-level boundary, so a rejection
// caught here is indistinguishable on the wire from one that escaped to
// app.ts — body-parser's 400/413 keep their own status and code, everything
// else becomes the opaque internal_error body. Answering with a router-specific
// 500 body, which is what the three routers that had an error handler did, broke
// that contract: the same class of failure got a different shape depending on
// which router it happened in. A response that already started streaming (SSE, a
// file download) is handed on instead: its status line is long gone, so the only
// honest thing left is to let Express destroy the connection.
export function routerErrorHandler(tag: string) {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    // Report first, log second: the app-level boundary reports the error to
    // Sentry (sendInternalError), which marks it as already sent, so the
    // console bridge recognises the log line below and does not file a
    // second event. Logging first produced two issues per router failure.
    handleUnhandledError(err, req, res, next);
    console.error(`${tag} unhandled route error`, err);
  };
}
