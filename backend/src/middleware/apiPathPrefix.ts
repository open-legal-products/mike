import type { RequestHandler } from "express";

/**
 * Remove a path prefix a front proxy leaves on every request.
 *
 * The backend's routes are mounted at the root and normally sit behind a
 * gateway that strips `/api` (the Next.js route in frontend/src/app/api, the
 * Word add-in host). On Vercel the platform routes `/api/*` straight to the
 * backend container with the path unchanged, so the start script sets
 * API_PATH_PREFIX=/api (docs/vercel.md). Unset, this is a no-op.
 */
export function stripApiPathPrefix(rawPrefix: string | undefined): RequestHandler {
  const prefix = rawPrefix?.trim().replace(/\/+$/, "") ?? "";
  if (!prefix || !prefix.startsWith("/")) {
    return (_req, _res, next) => next();
  }
  return (req, _res, next) => {
    const url = req.url;
    if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
      const rest = url.slice(prefix.length);
      req.url = rest.startsWith("/") ? rest : `/${rest}`;
    }
    next();
  };
}
