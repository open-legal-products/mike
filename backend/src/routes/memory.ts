import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { ParamsFlatDictionary } from "express-serve-static-core";
import { checkProjectAccess } from "../lib/access";
import { sendInternalError } from "../lib/httpError";
import {
  enableMemoryFile,
  ensureMemoryFile,
  getMemoryCurrent,
  MemoryDisabledError,
  MemoryValidationError,
  MemoryRevisionConflictError,
  wipeMemoryFile,
  writeMemoryFile,
  type MemoryFileRow,
  type MemoryScope,
} from "../lib/memory/files";
import { can, type Capability } from "../lib/permissions";
import { createServerSupabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";

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

type MemoryRequestContext = {
  scope: MemoryScope;
  ownerId: string;
  file: MemoryFileRow;
};

async function userContext(
  _req: Request<ParamsFlatDictionary>,
  res: Response,
): Promise<MemoryRequestContext | null> {
  const ownerId = res.locals.userId as string;
  const db = createServerSupabase();
  const file = await ensureMemoryFile(db, "user", ownerId);
  return { scope: "user", ownerId, file };
}

function projectContext(required: Capability) {
  return async (
    req: Request<ParamsFlatDictionary>,
    res: Response,
  ): Promise<MemoryRequestContext | null> => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = req.params.projectId;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok) {
      res.status(404).json({ detail: "Project not found" });
      return null;
    }
    if (!can(access.projectRole, required)) {
      res
        .status(403)
        .json({ detail: "You do not have permission to manage this memory." });
      return null;
    }
    const file = await ensureMemoryFile(db, "project", projectId);
    return { scope: "project", ownerId: projectId, file };
  };
}

function expectedRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

async function currentForContext(ctx: MemoryRequestContext) {
  return (
    await getMemoryCurrent(createServerSupabase(), ctx.scope, ctx.ownerId)
  ).current;
}

async function sendMemoryError(
  res: Response,
  error: unknown,
  ctx?: MemoryRequestContext,
): Promise<void> {
  if (error instanceof MemoryRevisionConflictError && ctx) {
    let current;
    try {
      current = await currentForContext(ctx);
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
  readContext: (
    req: Request<ParamsFlatDictionary>,
    res: Response,
  ) => Promise<MemoryRequestContext | null>,
  writeContext: (
    req: Request<ParamsFlatDictionary>,
    res: Response,
  ) => Promise<MemoryRequestContext | null>,
  settingsContext: (
    req: Request<ParamsFlatDictionary>,
    res: Response,
  ) => Promise<MemoryRequestContext | null>,
  wipeContext?: (
    req: Request<ParamsFlatDictionary>,
    res: Response,
  ) => Promise<MemoryRequestContext | null>,
) {
  router.get("/", async (req, res) => {
    try {
      const ctx = await readContext(req, res);
      if (!ctx) return;
      res.json(await currentForContext(ctx));
    } catch (error) {
      await sendMemoryError(res, error);
    }
  });

  router.put("/", async (req, res) => {
    let ctx: MemoryRequestContext | null = null;
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
      const current = (
        await writeMemoryFile({
          db: createServerSupabase(),
          file: ctx.file,
          content: req.body.content,
          expectedRevision: parsedVersion,
          source: "manual",
          updatedBy: res.locals.userId as string,
        })
      ).current;
      res.json(current);
    } catch (error) {
      await sendMemoryError(res, error, ctx ?? undefined);
    }
  });

  router.patch("/settings", async (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") {
        return void res
          .status(400)
          .json({ detail: "enabled must be a boolean" });
      }
      const ctx = await settingsContext(req, res);
      if (!ctx) return;
      const current = req.body.enabled
        ? await enableMemoryFile(
            createServerSupabase(),
            ctx.file,
            res.locals.userId as string,
          )
        : await wipeMemoryFile({
            db: createServerSupabase(),
            file: ctx.file,
            enabled: false,
            updatedBy: res.locals.userId as string,
            source: "settings",
          });
      res.json(current);
    } catch (error) {
      await sendMemoryError(res, error);
    }
  });

  if (wipeContext) {
    router.delete("/", async (req, res) => {
      try {
        const ctx = await wipeContext(req, res);
        if (!ctx) return;
        res.json(
          await wipeMemoryFile({
            db: createServerSupabase(),
            file: ctx.file,
            enabled: null,
            updatedBy: res.locals.userId as string,
            source: "wipe",
          }),
        );
      } catch (error) {
        await sendMemoryError(res, error);
      }
    });
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
