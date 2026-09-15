// HTTP layer for the memory module: GET/PUT the memory file, PATCH its
// enabled flag, DELETE (wipe) it — installed once on the user router and once
// on the project router with different access requirements. Handlers parse
// bodies, resolve the memory context through the service, and map the
// service's typed errors onto status codes.

import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { ParamsFlatDictionary } from "express-serve-static-core";
import { sendInternalError } from "../../lib/httpError";
import type { Capability } from "../../lib/permissions";
import { createServerSupabase } from "../../lib/supabase";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import {
  currentMemory,
  MemoryDisabledError,
  MemoryRevisionConflictError,
  MemoryValidationError,
  resolveProjectMemoryContext,
  resolveUserMemoryContext,
  saveMemory,
  setMemoryEnabled,
  wipeMemory,
  type MemoryContext,
} from "./memory.service";

export const userMemoryRouter = Router();
export const projectMemoryRouter = Router({ mergeParams: true });

userMemoryRouter.use(requireAuth);
projectMemoryRouter.use(requireAuth);
const privateNoStore = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
};
userMemoryRouter.use(privateNoStore);
projectMemoryRouter.use(privateNoStore);

type ContextResolver = (
  req: Request<ParamsFlatDictionary>,
  res: Response,
) => Promise<MemoryContext | null>;

async function userContext(
  _req: Request<ParamsFlatDictionary>,
  res: Response,
): Promise<MemoryContext | null> {
  return resolveUserMemoryContext(
    createServerSupabase(),
    res.locals.userId as string,
  );
}

function projectContext(required: Capability): ContextResolver {
  return async (req, res) => {
    const result = await resolveProjectMemoryContext(createServerSupabase(), {
      projectId: req.params.projectId,
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      required,
    });
    if (!result.ok) {
      res.status(result.status).json({ detail: result.detail });
      return null;
    }
    return result.context;
  };
}

function expectedRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

async function sendMemoryError(
  res: Response,
  error: unknown,
  ctx?: MemoryContext,
): Promise<void> {
  if (error instanceof MemoryRevisionConflictError && ctx) {
    let current;
    try {
      current = await currentMemory(createServerSupabase(), ctx);
    } catch {
      current = undefined;
    }
    res.status(409).json({
      code: "memory_revision_conflict",
      detail:
        "Memory changed since it was loaded. Review what is saved now and try again.",
      ...(current ? { current } : {}),
    });
    return;
  }
  if (error instanceof MemoryDisabledError) {
    res.status(409).json({
      code: "memory_disabled",
      detail: "Enable memory before editing it.",
    });
    return;
  }
  if (error instanceof MemoryValidationError) {
    const missing = /not found/i.test(error.message);
    res.status(missing ? 404 : 400).json({ detail: error.message });
    return;
  }
  sendInternalError(res, error);
}

function installMemoryRoutes(
  router: Router,
  readContext: ContextResolver,
  writeContext: ContextResolver,
  settingsContext: ContextResolver,
  wipeContext?: ContextResolver,
) {
  router.get("/", asyncRoute(async (req, res) => {
    try {
      const ctx = await readContext(req, res);
      if (!ctx) return;
      res.json(await currentMemory(createServerSupabase(), ctx));
    } catch (error) {
      await sendMemoryError(res, error);
    }
  }));

  router.put("/", asyncRoute(async (req, res) => {
    let ctx: MemoryContext | null = null;
    try {
      const parsedVersion = expectedRevision(req.body?.expected_revision);
      if (parsedVersion == null || typeof req.body?.content !== "string") {
        return void res.status(400).json({
          detail:
            "content and a non-negative integer expected_revision are required",
        });
      }
      ctx = await writeContext(req, res);
      if (!ctx) return;
      const current = await saveMemory(createServerSupabase(), {
        ctx,
        content: req.body.content,
        expectedRevision: parsedVersion,
        updatedBy: res.locals.userId as string,
      });
      res.json(current);
    } catch (error) {
      await sendMemoryError(res, error, ctx ?? undefined);
    }
  }));

  router.patch("/settings", asyncRoute(async (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") {
        return void res
          .status(400)
          .json({ detail: "enabled must be a boolean" });
      }
      const ctx = await settingsContext(req, res);
      if (!ctx) return;
      const current = await setMemoryEnabled(createServerSupabase(), {
        ctx,
        enabled: req.body.enabled,
        updatedBy: res.locals.userId as string,
      });
      res.json(current);
    } catch (error) {
      await sendMemoryError(res, error);
    }
  }));

  if (wipeContext) {
    router.delete("/", asyncRoute(async (req, res) => {
      try {
        const ctx = await wipeContext(req, res);
        if (!ctx) return;
        res.json(
          await wipeMemory(createServerSupabase(), {
            ctx,
            updatedBy: res.locals.userId as string,
          }),
        );
      } catch (error) {
        await sendMemoryError(res, error);
      }
    }));
  }
}

installMemoryRoutes(
  userMemoryRouter,
  userContext,
  userContext,
  userContext,
  userContext,
);
installMemoryRoutes(
  projectMemoryRouter,
  projectContext("project.view"),
  projectContext("content.edit"),
  projectContext("access.manage"),
);

userMemoryRouter.use(routerErrorHandler("[user-memory]"));
projectMemoryRouter.use(routerErrorHandler("[project-memory]"));
