// HTTP layer for the models module: the model-catalog listing endpoints.
//
// Route handlers read the authenticated user off res.locals, call the
// models.service catalog functions, and map their typed results onto status
// codes and JSON. A missing provider key is a 422 the settings UI keys off;
// an upstream catalog failure is a 502 whose raw body never reaches the
// client.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase, type Db } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import {
    listOllamaModels,
    listOpenCodeGoModels,
    listOpenRouterModels,
    listVercelModels,
    type CatalogFailure,
    type CatalogResult,
} from "./models.service";

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
 */
async function sendCatalog(
    res: Response,
    lookup: (db: Db, userId: string) => Promise<CatalogResult>,
): Promise<void> {
    const userId = res.locals.userId as string;
    try {
        const result = await lookup(createServerSupabase(), userId);
        if (!result.ok) return void sendCatalogFailure(res, result);
        res.json({ models: result.models });
    } catch (error) {
        sendInternalError(res, error);
    }
}

// GET /models/ollama
modelsRouter.get("/ollama", requireAuth, async (_req, res) => {
    res.json({ models: await listOllamaModels() });
});

// GET /models/openrouter
modelsRouter.get("/openrouter", requireAuth, (_req, res) =>
    sendCatalog(res, listOpenRouterModels),
);

// GET /models/vercel
modelsRouter.get("/vercel", requireAuth, (_req, res) =>
    sendCatalog(res, listVercelModels),
);

// GET /models/opencode-go
modelsRouter.get("/opencode-go", requireAuth, (_req, res) =>
    sendCatalog(res, listOpenCodeGoModels),
);
