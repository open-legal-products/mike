// HTTP layer for the user module. Handlers parse params/query/body, call the
// service functions behind user.service.ts, and map their typed results onto
// status codes, headers, and JSON bodies. The MFA step-up guard
// (requireMfaIfEnrolled) is applied here, per route — keep it on every
// mutating /user route so the service layer never has to know about MFA.

import crypto from "crypto";
import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { recordAudit } from "../../lib/audit";
import { sendInternalError } from "../../lib/httpError";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import { buildContentDisposition } from "../../lib/storage";
import { normalizeApiKeyProvider } from "./user.apiKeyStore";
import { completeUserMcpConnectorOAuth } from "../../lib/mcpConnectors";
import { userExportFilename } from "../../lib/userDataExport";
import { configuredApiPublicUrl } from "../../lib/runtimeConfig";
import {
    bootstrapUserProfile,
    completeUserOnboarding,
    createMcpConnector,
    deleteMcpConnector,
    deleteUserAccount,
    deleteUserChats,
    deleteUserProjectsData,
    deleteUserTabularReviews,
    errorMessage,
    exportUserAccount,
    exportUserChats,
    exportUserTabularReviews,
    getApiKeyStatus,
    getMcpConnector,
    getUserExportStatus,
    getUserProfile,
    loadUserExportArtifact,
    lookupUserByEmail,
    listMcpConnectors,
    readBooleanBodyField,
    recordPasswordSet,
    refreshMcpConnectorTools,
    saveApiKey,
    setMcpToolEnabled,
    setMfaOnLogin,
    startMcpConnectorOAuth,
    startUserExport,
    updateMcpConnector,
    updateUserProfile,
    validateExportRequest,
    validateOnboardingPayload,
    validateProfilePayload,
} from "./user.service";

export const userRouter = Router();

function backendPublicUrl(req: {
    protocol: string;
    get(name: string): string | undefined;
}) {
    const configured = configuredApiPublicUrl();
    if (configured) return configured;
    if (process.env.NODE_ENV === "production") {
        throw new Error("API_PUBLIC_URL is required for connector OAuth");
    }
    const host = req.get("host");
    if (!host) throw new Error("Request host is required for connector OAuth");
    return new URL(`${req.protocol}://${host}`).origin;
}

function frontendUrl(path = "/settings/connectors") {
    const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
        /\/+$/,
        "",
    );
    return `${base}${path}`;
}

function shortHash(value: string) {
    return value
        ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)
        : null;
}

function mcpOAuthPopupHtml(payload: {
    success: boolean;
    connectorId?: string;
    detail?: string;
}, nonce: string) {
    const targetOrigin = new URL(frontendUrl()).origin;
    const targetUrl = frontendUrl();
    const message = JSON.stringify({
        type: "mcp_oauth_result",
        ...payload,
    });
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP authorization</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; }
      main { max-width: 360px; padding: 24px; text-align: center; }
      p { color: #6b7280; }
    </style>
  </head>
  <body>
    <main>
      <h1>${payload.success ? "Authorization complete" : "Authorization failed"}</h1>
      <p>${payload.success ? "You can return to Mike." : "Return to Mike and try connecting again."}</p>
    </main>
    <script nonce="${nonce}">
      const message = ${message};
      const targetUrl = ${JSON.stringify(targetUrl)};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, ${JSON.stringify(targetOrigin)});
      }
      setTimeout(() => window.close(), ${payload.success ? 600 : 2500});
      ${
          payload.success
              ? "setTimeout(() => window.location.assign(targetUrl), 1000);"
              : ""
      }
    </script>
  </body>
</html>`;
}

function mcpOAuthPopupCsp(nonce: string) {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join("; ");
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await bootstrapUserProfile(db, userId);
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json({ ok: true });
});

// GET /user/lookup?email=person@example.com
userRouter.get("/lookup", requireAuth, async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!email.trim()) {
        return void res.status(400).json({ detail: "email is required" });
    }

    const db = createServerSupabase();
    res.json(await lookupUserByEmail(db, email));
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await getUserProfile(db, userId);
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json(result.body);
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const parsed = validateProfilePayload(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const db = createServerSupabase();
    const result = await updateUserProfile(
        db,
        userId,
        parsed.update,
        parsed.routerModels,
    );
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json(result.body);
});

// POST /user/onboarding
userRouter.post("/onboarding", requireAuth, async (req, res) => {
    const parsed = validateOnboardingPayload(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await completeUserOnboarding(db, userId, parsed.update);
    if (!result.ok) return void res.status(500).json({ detail: result.detail });
    res.json(result.body);
});

// POST /user/security/password-set
// Record password capability only after verifying Supabase's auth.users row.
userRouter.post("/security/password-set", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await recordPasswordSet(db, userId);
    if (!result.ok) {
        if (result.kind === "not_recorded")
            return void res.status(409).json({ detail: result.detail });
        return void res.status(500).json({ detail: result.detail });
    }
    res.json(result.body);
});

// PATCH /user/security/mfa-login
userRouter.patch(
    "/security/mfa-login",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerSupabase();
        const result = await setMfaOnLogin(db, userId, parsed.value);
        if (!result.ok) {
            if (result.kind === "no_factor")
                return void res.status(400).json({ detail: result.detail });
            return void sendInternalError(res, result.error);
        }
        res.json(result.body);
    },
);

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const status = await getApiKeyStatus(db, userId);
    res.json(status);
});

// PUT /user/api-keys/:provider
userRouter.put(
    "/api-keys/:provider",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider)
            return void res
                .status(400)
                .json({ detail: "Unsupported provider" });

        const apiKey =
            typeof req.body?.api_key === "string" ? req.body.api_key : null;
        const db = createServerSupabase();
        const result = await saveApiKey(db, { userId, provider, apiKey });
        if (!result.ok) {
            if (result.kind === "env_configured")
                return void res.status(409).json({
                    detail: "This provider is configured by the server environment and cannot be changed from the browser.",
                });
            return void sendInternalError(res, result.error);
        }
        res.json(result.status);
    },
);

// GET /user/mcp-connectors
userRouter.get("/mcp-connectors", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listMcpConnectors(db, userId);
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json(result.connectors);
});

// GET /user/mcp-connectors/:connectorId
userRouter.get(
    "/mcp-connectors/:connectorId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await getMcpConnector(
            db,
            userId,
            req.params.connectorId,
        );
        if (!result.ok)
            return void res
                .status(404)
                .json({ detail: "Connector not found" });
        res.json(result.connector);
    },
);

// POST /user/mcp-connectors
userRouter.post(
    "/mcp-connectors",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const name = typeof req.body?.name === "string" ? req.body.name : "";
        const serverUrl =
            typeof req.body?.serverUrl === "string" ? req.body.serverUrl : "";
        const bearerToken =
            typeof req.body?.bearerToken === "string"
                ? req.body.bearerToken
                : null;
        const headers =
            req.body?.headers &&
            typeof req.body.headers === "object" &&
            !Array.isArray(req.body.headers)
                ? (req.body.headers as Record<string, unknown>)
                : undefined;
        const db = createServerSupabase();
        const result = await createMcpConnector(db, userId, {
            name,
            serverUrl,
            bearerToken,
            headers,
        });
        if (!result.ok)
            return void res.status(400).json({
                detail: "Connector settings are invalid or the server could not be reached.",
            });
        res.status(201).json(result.connector);
    },
);

// PATCH /user/mcp-connectors/:connectorId
userRouter.patch(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const body = req.body ?? {};
        const result = await updateMcpConnector(
            db,
            userId,
            req.params.connectorId,
            {
                ...(typeof body.name === "string" ? { name: body.name } : {}),
                ...(typeof body.serverUrl === "string"
                    ? { serverUrl: body.serverUrl }
                    : {}),
                ...(typeof body.enabled === "boolean"
                    ? { enabled: body.enabled }
                    : {}),
                ...("bearerToken" in body
                    ? {
                          bearerToken:
                              typeof body.bearerToken === "string"
                                  ? body.bearerToken
                                  : null,
                      }
                    : {}),
                ...("headers" in body
                    ? {
                          headers:
                              body.headers &&
                              typeof body.headers === "object" &&
                              !Array.isArray(body.headers)
                                  ? (body.headers as Record<string, unknown>)
                                  : {},
                      }
                    : {}),
            },
        );
        if (!result.ok)
            return void res.status(400).json({
                detail: "Connector settings are invalid or the server could not be reached.",
            });
        res.json(result.connector);
    },
);

// DELETE /user/mcp-connectors/:connectorId
userRouter.delete(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await deleteMcpConnector(
            db,
            userId,
            req.params.connectorId,
        );
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    },
);

// POST /user/mcp-connectors/:connectorId/oauth/start
userRouter.post(
    "/mcp-connectors/:connectorId/oauth/start",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const redirectUri = `${backendPublicUrl(req)}/user/mcp-connectors/oauth/callback`;
        const result = await startMcpConnectorOAuth(
            db,
            userId,
            req.params.connectorId,
            redirectUri,
        );
        if (!result.ok)
            return void res.status(400).json({
                detail: "Connector authorization could not be started.",
            });
        res.json({
            ...result.result,
            callbackOrigin: new URL(redirectUri).origin,
        });
    },
);

// GET /user/mcp-connectors/oauth/callback
userRouter.get("/mcp-connectors/oauth/callback", async (req, res) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const error =
        typeof req.query.error === "string" ? req.query.error : undefined;
    const db = createServerSupabase();
    try {
        if (error) throw new Error(error);
        if (!state || !code)
            throw new Error("OAuth callback is missing state or code.");
        const result = await completeUserMcpConnectorOAuth(state, code, db);
        res.set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
            .type("html")
            .send(
                mcpOAuthPopupHtml(
                    {
                        success: true,
                        connectorId: result.connectorId,
                    },
                    nonce,
                ),
            );
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] oauth callback failed", {
            error: detail,
            stateHash: shortHash(state),
            hasCode: !!code,
            hasError: !!error,
            issuer:
                typeof req.query.iss === "string" ? req.query.iss : undefined,
            scope:
                typeof req.query.scope === "string"
                    ? req.query.scope
                    : undefined,
        });
        res.status(400)
            .set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
            .type("html")
            .send(
                mcpOAuthPopupHtml(
                    {
                        success: false,
                        detail: "Connector authorization could not be completed.",
                    },
                    nonce,
                ),
            );
    }
});

// POST /user/mcp-connectors/:connectorId/refresh-tools
userRouter.post(
    "/mcp-connectors/:connectorId/refresh-tools",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await refreshMcpConnectorTools(
            db,
            userId,
            req.params.connectorId,
        );
        if (!result.ok) {
            if (result.kind === "oauth_required")
                return void res.status(401).json({
                    code: result.code,
                    detail: "This connector needs to be authorized again.",
                });
            return void res.status(400).json({
                detail: "Connector tools could not be refreshed.",
            });
        }
        res.json(result.connector);
    },
);

// PATCH /user/mcp-connectors/:connectorId/tools/:toolId
userRouter.patch(
    "/mcp-connectors/:connectorId/tools/:toolId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerSupabase();
        const result = await setMcpToolEnabled(
            db,
            userId,
            req.params.connectorId,
            req.params.toolId,
            parsed.value,
        );
        if (!result.ok)
            return void res.status(400).json({
                detail: "Connector tool settings could not be updated.",
            });
        res.json(result.connector);
    },
);

// DELETE /user/account
userRouter.delete(
    "/account",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const token = res.locals.token as string | undefined;
        const db = createServerSupabase();
        const result = await deleteUserAccount(db, userId, userEmail, token);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    },
);

// DELETE /user/chats
userRouter.delete(
    "/chats",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await deleteUserChats(db, userId);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    },
);

// DELETE /user/projects
userRouter.delete(
    "/projects",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await deleteUserProjectsData(db, userId);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    },
);

// DELETE /user/tabular-reviews
userRouter.delete(
    "/tabular-reviews",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await deleteUserTabularReviews(db, userId);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    },
);

// GET /user/export
userRouter.get(
    "/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await exportUserAccount(db, userId, userEmail);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${userExportFilename("account", userId)}"`,
        );
        void recordAudit(createServerSupabase(), {
            userId,
            userEmail: res.locals.userEmail as string | undefined,
            action: "export.account",
            surface: "account",
        });
        res.json(result.data);
    },
);

// GET /user/chats/export
userRouter.get(
    "/chats/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await exportUserChats(db, userId, userEmail);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${userExportFilename("chats", userId)}"`,
        );
        void recordAudit(createServerSupabase(), {
            userId,
            userEmail: res.locals.userEmail as string | undefined,
            action: "export.chats",
            surface: "account",
        });
        res.json(result.data);
    },
);

// GET /user/tabular-reviews/export
userRouter.get(
    "/tabular-reviews/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await exportUserTabularReviews(db, userId, userEmail);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${userExportFilename("tabular-reviews", userId)}"`,
        );
        void recordAudit(createServerSupabase(), {
            userId,
            userEmail: res.locals.userEmail as string | undefined,
            action: "export.tabular",
            surface: "account",
        });
        res.json(result.data);
    },
);

// ---------------------------------------------------------------------------
// Async exports (durable): POST creates a DB-queue job that builds the
// export off the request thread; GET polls it; the download endpoint streams
// the finished artifact. The synchronous GET /user/*/export routes above
// still work (curl users, older clients) — the frontend uses this flow so a
// large export can neither time out the request nor die with a dropped tab.
// Artifacts expire after 24 hours (the runner's retention sweep deletes the
// file and the job row).

// POST /user/exports  { type, params? }
userRouter.post(
    "/exports",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const body = (req.body ?? {}) as {
            type?: string;
            params?: Record<string, unknown>;
        };
        // Validated before the Supabase client is constructed, so a bad
        // request is a 400 rather than a connection-time failure.
        const parsed = validateExportRequest({ userId, userEmail, body });
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        // Nothing on this process will ever drain db_jobs, so a 202 would be
        // a receipt for work that cannot happen — and worse than useless: the
        // pending row holds the (user, type) dedupe key forever, so the user
        // could never successfully start that export again, even after an
        // operator turns the runner back on. Refuse instead. The synchronous
        // GET /user/*/export routes still work, which is the escape hatch.
        if (!dbJobsEnabled())
            return void res.status(503).json({
                detail: "Exports are temporarily unavailable. Please try again later.",
            });

        const db = createServerSupabase();
        const result = await startUserExport(db, {
            userId,
            type: parsed.type,
            payload: parsed.payload,
        });
        if (!result.ok)
            return void res.status(500).json({ detail: result.detail });
        res.status(202).json({ export_id: result.exportId });
    },
);

// GET /user/exports/:exportId — poll until status is "done", then fetch
// GET /user/exports/:exportId/download.
userRouter.get(
    "/exports/:exportId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await getUserExportStatus(
            db,
            req.params.exportId,
            userId,
        );
        if (!result.ok)
            return void res.status(404).json({ detail: "Export not found" });
        res.json(result.body);
    },
);

// GET /user/exports/:exportId/download — stream the finished artifact.
// Authenticated + ownership-checked on every request (unlike /download/:token,
// which only serves paths backed by a document_versions row and would 404 on
// an export artifact); artifacts expire after 24h.
userRouter.get(
    "/exports/:exportId/download",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await loadUserExportArtifact(
            db,
            req.params.exportId,
            userId,
        );
        if (!result.ok)
            return void res.status(404).json({
                detail:
                    result.kind === "expired"
                        ? "Export expired"
                        : "Export not found",
            });
        res.setHeader("Content-Type", result.contentType);
        res.setHeader(
            "Content-Disposition",
            buildContentDisposition("attachment", result.filename),
        );
        res.send(result.body);
    },
);
