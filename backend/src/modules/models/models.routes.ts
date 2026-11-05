// HTTP layer for the models module: the model-catalog listing endpoints.
//
// Route handlers read the authenticated user off res.locals, call the
// models.service catalog functions, and map their typed results onto status
// codes and JSON. A missing provider key is a 422 the settings UI keys off;
// an upstream catalog failure is a 502 whose raw body never reaches the
// client.

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase, type Db } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import {
    PERSONAL_WORKSPACE,
    resolveWorkspaceFilter,
    sendWorkspaceFailure,
} from "../../lib/workspace";
import {
    listOllamaModels,
    listConfiguredModels,
    listOpenCodeGoModels,
    listOpenRouterModels,
    listVercelModels,
    listBedrockModels,
    listCustomEndpointModels,
    listXaiModels,
} from "./models.service";
import { type CatalogFailure, type CatalogResult } from "./models.types";

export const modelsRouter = Router();

function sendCatalogFailure(res: Response, failure: CatalogFailure): void {
    if (failure.kind === "missing_api_key") {
        res.status(422).json({ code: failure.code, detail: failure.detail });
        return;
    }
    if (failure.kind === "upstream") {
        sendInternalError(res, failure.error, 502);
        return;
    }
    sendInternalError(res, failure.error);
}

/**
 * Run one provider catalog lookup and render its typed result. Obtaining the
 * database handle is inside the same guard as the lookup so a misconfigured
 * environment still answers the generic 500 rather than hanging the request.
 *
 * `?workspace=<organization id>` lists with the key that organization's work
 * runs on, which is how its admins choose the models its key may run. The
 * caller's membership is checked here and again where the key is read.
 */
async function sendCatalog(
    req: Request,
    res: Response,
    lookup: (
        db: Db,
        userId: string,
        orgId?: string | null,
    ) => Promise<CatalogResult>,
): Promise<void> {
    const userId = res.locals.userId as string;
    try {
        const db = createServerSupabase();
        const workspace = await resolveWorkspaceFilter(
            db,
            userId,
            req.query.workspace,
        );
        if (!workspace.ok) return void sendWorkspaceFailure(res, workspace);
        const orgId =
            workspace.workspace && workspace.workspace !== PERSONAL_WORKSPACE
                ? workspace.workspace
                : null;
        const result = await lookup(db, userId, orgId);
        if (!result.ok) return void sendCatalogFailure(res, result);
        res.json({ models: result.models });
    } catch (error) {
        sendInternalError(res, error);
    }
}

// GET /models/ollama
modelsRouter.get("/ollama", requireAuth, asyncRoute(async (_req, res) => {
    res.json({ models: await listOllamaModels() });
}));

// GET /models/configured
modelsRouter.get("/configured", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const models = await listConfiguredModels(createServerSupabase(), userId);
    res.json({ models });
}));

// GET /models/openrouter
modelsRouter.get("/openrouter", requireAuth, (req, res) =>
    sendCatalog(req, res, listOpenRouterModels),
);

// GET /models/vercel
modelsRouter.get("/vercel", requireAuth, (req, res) =>
    sendCatalog(req, res, listVercelModels),
);

// GET /models/opencode-go
modelsRouter.get("/opencode-go", requireAuth, (req, res) =>
    sendCatalog(req, res, listOpenCodeGoModels),
);

modelsRouter.get("/bedrock", requireAuth, (req, res) =>
    sendCatalog(req, res, listBedrockModels),
);

// GET /models/xai
modelsRouter.get("/xai", requireAuth, (req, res) =>
    sendCatalog(req, res, listXaiModels),
);

// GET /models/custom
modelsRouter.get("/custom", requireAuth, (req, res) =>
    sendCatalog(req, res, listCustomEndpointModels),
);

modelsRouter.use(routerErrorHandler("[models]"));
