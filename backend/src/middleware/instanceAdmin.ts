import type { NextFunction, Request, Response } from "express";
import { isInstanceAdmin } from "../lib/instanceAdmin";

export const INSTANCE_ADMIN_REQUIRED_CODE = "instance_admin_required";

/**
 * Allows only instance admins (MIKE_ADMIN_EMAILS) past. Mount it after
 * requireAuth, which sets the confirmed address in res.locals.userEmail.
 */
export function requireInstanceAdmin(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isInstanceAdmin(res.locals.userEmail)) {
    res.status(403).json({
      code: INSTANCE_ADMIN_REQUIRED_CODE,
      detail: "Only an administrator of this Mike server can do that.",
    });
    return;
  }
  next();
}
