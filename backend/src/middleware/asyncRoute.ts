// Shared plumbing for async Express handlers.
//
// Express 4 does not understand promises: an `async` handler that rejects is
// invisible to the router, so the request hangs until the client or the proxy
// times out and nothing is logged. `asyncRoute` forwards the rejection to
// `next(err)`, where an error middleware turns it into a response.

import type { NextFunction, Request, Response } from "express";
import { handleUnhandledError } from "./internalErrorResponse";

export type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

export function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

// Builds a router-scoped error middleware. Express 4 identifies error
// middleware purely by arity, so all four parameters must stay declared even
// when a router does not use them.
//
// Its only job is to attribute the failure to a router in the logs; the
// response itself is delegated to the same app-level boundary, so a rejection
// caught here is indistinguishable on the wire from one that escaped to
// app.ts — body-parser's 400/413 keep their own status and code, everything
// else becomes the opaque internal_error body. A response that already started
// streaming (SSE, a file download) is handed on instead: its status line is
// long gone, so the only honest thing left is to let Express destroy the
// connection.
export function routerErrorHandler(tag: string) {
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error(`${tag} unhandled route error`, err);
    handleUnhandledError(err, req, res, next);
  };
}
