// HTTP surface for the playbook (Janus `/playbook`, admin-gated editor).
//   GET   /playbook       every rule, active or not (any signed-in user)
//   POST  /playbook       create a rule (admin)
//   PATCH /playbook/:id   edit fields / toggle is_active (admin)
// Handlers only parse, call the service and map ServiceResults to statuses.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { failure, sendServiceFailure } from "../../lib/serviceResult";
import { callerIsAdmin } from "../contracts/contracts.service";
import { createPlaybookRule, listPlaybookRules, parseCreateRuleBody, parsePatchRuleBody, updatePlaybookRule } from "./playbook.service";

export const playbookRouter = Router();
playbookRouter.use(requireAuth);

const ADMIN_REQUIRED = failure("forbidden", "Hanya administrator yang dapat mengubah aturan playbook.");

playbookRouter.get("/", asyncRoute(async (_req, res) => {
  const result = await listPlaybookRules(createServerSupabase());
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

playbookRouter.post("/", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  if (!(await callerIsAdmin(db, res.locals.userId as string))) return void sendServiceFailure(res, ADMIN_REQUIRED);
  const parsed = parseCreateRuleBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await createPlaybookRule(db, parsed.data);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

playbookRouter.patch("/:id", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  if (!(await callerIsAdmin(db, res.locals.userId as string))) return void sendServiceFailure(res, ADMIN_REQUIRED);
  const parsed = parsePatchRuleBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await updatePlaybookRule(db, req.params.id, parsed.data);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

playbookRouter.use(routerErrorHandler);
