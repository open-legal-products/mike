// HTTP layer for the admin module: the instance admin panel's API.
//
// Every route is behind requireAuth and requireInstanceAdmin, so a signed-in
// user who is not listed in MIKE_ADMIN_EMAILS gets 403 instance_admin_required
// before any handler runs. Changes step up to MFA like other sensitive
// settings. Handlers parse params and body, call admin.service, and map its
// ServiceResult onto a status code and JSON.

import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { requireInstanceAdmin } from "../../middleware/instanceAdmin";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { isUuid } from "../../lib/uuid";
import {
  findUserFeatureFlagsByEmail,
  listFeatureFlags,
  updateFeatureFlagDefault,
  updateUserFeatureFlag,
} from "./admin.service";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireInstanceAdmin);

const actor = (res: { locals: Record<string, unknown> }) => ({
  userId: res.locals.userId as string,
  email: res.locals.userEmail as string | undefined,
});

/** `{ enabled: true | false | null }`; anything else is reported by the service. */
const enabledField = (body: unknown): unknown =>
  body && typeof body === "object" && "enabled" in body
    ? (body as { enabled: unknown }).enabled
    : undefined;

// GET /admin/feature-flags
adminRouter.get("/feature-flags", asyncRoute(async (_req, res) => {
  const result = await listFeatureFlags(createServerSupabase());
  if (!result.ok) return void sendServiceFailure(res, result);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(result.data);
}));

// PUT /admin/feature-flags/:key — the deployment default
adminRouter.put(
  "/feature-flags/:key",
  requireMfaIfEnrolled,
  asyncRoute(async (req, res) => {
    const result = await updateFeatureFlagDefault(
      createServerSupabase(),
      actor(res),
      { key: String(req.params.key), enabled: enabledField(req.body) },
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

// GET /admin/users/feature-flags?email=person@example.com
adminRouter.get("/users/feature-flags", asyncRoute(async (req, res) => {
  const result = await findUserFeatureFlagsByEmail(
    createServerSupabase(),
    req.query.email,
  );
  if (!result.ok) return void sendServiceFailure(res, result);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(result.data);
}));

// PUT /admin/users/:userId/feature-flags/:key — one user's override
adminRouter.put(
  "/users/:userId/feature-flags/:key",
  requireMfaIfEnrolled,
  asyncRoute(async (req, res) => {
    const userId = String(req.params.userId);
    if (!isUuid(userId))
      return void res.status(400).json({ detail: "Invalid user id." });
    const result = await updateUserFeatureFlag(
      createServerSupabase(),
      actor(res),
      { userId, key: String(req.params.key), enabled: enabledField(req.body) },
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

adminRouter.use(routerErrorHandler("[admin]"));
