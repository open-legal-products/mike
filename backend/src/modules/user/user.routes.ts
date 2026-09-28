import { GoogleWorkspaceError, startWorkspaceOAuth, completeWorkspaceOAuth, cancelWorkspaceOAuth, disconnectWorkspace, updateWorkspaceSettings, setWorkspaceToolEnabled } from "../../lib/integrations/googleWorkspaceAuth";
import { workspaceConnectorStatus, workspaceToolList } from "../../lib/integrations/googleWorkspace";
// HTTP layer for the user module. Handlers parse params/query/body, call the
// service functions behind user.service.ts, and map their typed results onto
// status codes, headers, and JSON bodies. The MFA step-up guard
// (requireMfaIfEnrolled) is applied here, per route — keep it on every
// mutating /user route so the service layer never has to know about MFA.

import { safeError } from "../../lib/safeError";
import {
    cancelGoogleDriveOAuth,
    completeGoogleDriveOAuth,
    disconnectGoogleDrive,
    getGoogleDriveStatus,
    setGoogleDriveToolEnabled,
    startGoogleDriveOAuth,
    updateGoogleDriveSettings,
} from "../../lib/integrations/googleDrive";
import { ConnectorSetupError } from "../../lib/mcp/errors";

import crypto from "crypto";
import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import { sendServiceFailure } from "../../lib/serviceResult";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import { buildContentDisposition } from "../../lib/storage";
import { normalizeApiKeyProvider } from "./user.apiKeyStore";
import { completeUserMcpConnectorOAuth } from "../../lib/mcpConnectors";
import { conciseMcpErrorMessage } from "../../lib/mcp/errors";
import {
    acceptInvitation,
    declineInvitation,
    listMyInvitations,
} from "../../lib/orgs";
import { sendOrgFailure } from "../../lib/orgFailure";
import { configuredApiPublicUrl } from "../../lib/runtimeConfig";
import {
    bootstrapUserProfile,
    completeUserOnboarding,
    createMcpConnector,
    deleteMcpConnector,
    deletePrivateMemories,
    deleteUserAccount,
    describeAccountDeletionBlockers,
    deleteUserChats,
    deleteUserProjectsData,
    deleteUserTabularReviews,
    errorMessage,
    getApiKeyStatus,
    getCustomInstructions,
    getResponseStyle,
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
    validateCustomInstructionsPayload,
    saveCustomInstructions,
    validateResponseStylePayload,
    saveResponseStyle,
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
    // `detail` carries the attacker-controllable ?error= query value into this
    // inline script. JSON.stringify does not escape "<", so a payload of
    // "</script><script>…" would break out of the script element; escaping
    // "<" as its \u003c form keeps the string inside the JS literal. The CSP
    // nonce is the primary defense, but the popup now keeps a live
    // window.opener (COOP is relaxed on this route), so this is the belt to
    // that suspenders.
    const message = JSON.stringify({
        type: "mcp_oauth_result",
        ...payload,
    }).replace(/</g, "\\u003c");
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

function mcpOAuthPopupHeaders(nonce: string) {
    return {
        "Content-Security-Policy": [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            "style-src 'unsafe-inline'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ].join("; "),
        // The whole popup hand-off hinges on window.opener surviving until
        // this page has posted its result back to the app. Helmet's default
        // Cross-Origin-Opener-Policy of same-origin would move this document
        // into a fresh browsing-context group the moment the popup arrives
        // here from the (cross-origin) consent page — severing window.opener
        // and silently breaking the flow in every browser. This route opts
        // out; the strict CSP above still leaves the page unable to do
        // anything beyond its inline postMessage script.
        "Cross-Origin-Opener-Policy": "unsafe-none",
    };
}

// POST /user/profile
userRouter.post("/profile", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await bootstrapUserProfile(db, userId);
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json({ ok: true });
}));

// GET /user/lookup?email=person@example.com
userRouter.get("/lookup", requireAuth, asyncRoute(async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!email.trim()) {
        return void res.status(400).json({ detail: "email is required" });
    }

    const db = createServerSupabase();
    res.json(await lookupUserByEmail(db, email));
}));

// ---------------------------------------------------------------------------
// Organization invitations — the recipient's side
// ---------------------------------------------------------------------------
//
// These live on /user rather than /orgs because the caller is not (yet) a
// member of the organization: an /orgs/:orgId route would have to answer
// "which org?" before it could answer "are you allowed to know?". Matching is
// by the authenticated account's email, which is what lets an invitation sent
// before signup be claimed the moment the account exists.

// GET /user/invitations — live invitations addressed to the caller's email.
userRouter.get("/invitations", requireAuth, asyncRoute(async (_req, res) => {
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await listMyInvitations(db, { userEmail });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.invitations);
}));

// POST /user/invitations/:invitationId/accept — join the organization.
userRouter.post(
    "/invitations/:invitationId/accept",
    requireAuth,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await acceptInvitation(db, {
            userId,
            userEmail,
            invitationId: req.params.invitationId,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json({ org_id: result.org_id, role: result.role });
    }),
);

// POST /user/invitations/:invitationId/decline
userRouter.post(
    "/invitations/:invitationId/decline",
    requireAuth,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await declineInvitation(db, {
            userId,
            userEmail,
            invitationId: req.params.invitationId,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.status(204).send();
    }),
);

// GET /user/profile
userRouter.get("/profile", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await getUserProfile(db, userId);
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json(result.body);
}));

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, asyncRoute(async (req, res) => {
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
}));

// GET /user/custom-instructions
userRouter.get("/custom-instructions", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const result = await getCustomInstructions(createServerSupabase(), userId);
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result.data);
}));

// PUT /user/custom-instructions
userRouter.put("/custom-instructions", requireAuth, asyncRoute(async (req, res) => {
    const parsed = validateCustomInstructionsPayload(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const userId = res.locals.userId as string;
    const result = await saveCustomInstructions(
        createServerSupabase(),
        userId,
        parsed.content,
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result.data);
}));

// GET /user/response-style
userRouter.get("/response-style", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const result = await getResponseStyle(createServerSupabase(), userId);
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result.data);
}));

// PUT /user/response-style
userRouter.put("/response-style", requireAuth, asyncRoute(async (req, res) => {
    const parsed = validateResponseStylePayload(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const userId = res.locals.userId as string;
    const result = await saveResponseStyle(
        createServerSupabase(),
        userId,
        parsed.update,
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result.data);
}));

// POST /user/onboarding
userRouter.post("/onboarding", requireAuth, asyncRoute(async (req, res) => {
    const parsed = validateOnboardingPayload(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await completeUserOnboarding(db, userId, parsed.update);
    if (!result.ok) return void res.status(500).json({ detail: result.detail });
    res.json(result.body);
}));

// POST /user/security/password-set
// Record password capability only after verifying Supabase's auth.users row.
userRouter.post("/security/password-set", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await recordPasswordSet(db, userId);
    if (!result.ok) {
        if (result.kind === "not_recorded")
            return void res.status(409).json({ detail: result.detail });
        return void res.status(500).json({ detail: result.detail });
    }
    res.json(result.body);
}));

// PATCH /user/security/mfa-login
userRouter.patch(
    "/security/mfa-login",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
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
    }),
);

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const status = await getApiKeyStatus(db, userId);
    res.json(status);
}));

// PUT /user/api-keys/:provider
userRouter.put(
    "/api-keys/:provider",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
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
            return void sendInternalError(res, result.error);
        }
        res.json(result.status);
    }),
);

// GET /user/mcp-connectors
userRouter.get("/mcp-connectors", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listMcpConnectors(db, userId);
    if (!result.ok) return void sendInternalError(res, result.error);
    res.json(result.connectors);
}));

// GET /user/mcp-connectors/:connectorId
userRouter.get(
    "/mcp-connectors/:connectorId",
    requireAuth,
    asyncRoute(async (req, res) => {
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
    }),
);

// POST /user/mcp-connectors
userRouter.post(
    "/mcp-connectors",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
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
        if (!result.ok) {
            if (result.kind === "setup")
                return void res
                    .status(400)
                    .json({ code: result.code, detail: result.detail });
            if (result.kind === "cleanup")
                return void res.status(409).json({
                    code: "connector_cleanup_failed",
                    connectorId: result.connectorId,
                    detail:
                        "Connector validation failed, and the incomplete connector could not be removed. Remove it from Installed before trying again.",
                });
            return void res.status(400).json({
                detail: "Connector settings are invalid or the server could not be reached.",
            });
        }
        res.status(201).json({
            connector: result.connector,
            oauthRequired: result.oauthRequired,
        });
    }),
);

// PATCH /user/mcp-connectors/:connectorId
userRouter.patch(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const body = req.body ?? {};
        if (body.readOnly !== undefined && typeof body.readOnly !== "boolean")
            return void res.status(400).json({ detail: "readOnly must be a boolean." });
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
                ...(typeof body.readOnly === "boolean" ? { readOnly: body.readOnly } : {}),
                ...(typeof body.requireWriteApproval === "boolean"
                    ? { requireWriteApproval: body.requireWriteApproval }
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
    }),
);

// DELETE /user/mcp-connectors/:connectorId
userRouter.delete(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await deleteMcpConnector(
            db,
            userId,
            req.params.connectorId,
        );
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    }),
);

// POST /user/mcp-connectors/:connectorId/oauth/start
userRouter.post(
    "/mcp-connectors/:connectorId/oauth/start",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const redirectUri = `${backendPublicUrl(req)}/user/mcp-connectors/oauth/callback`;
        const result = await startMcpConnectorOAuth(
            db,
            userId,
            req.params.connectorId,
            redirectUri,
        );
        if (!result.ok) {
            if (result.kind === "setup")
                return void res
                    .status(400)
                    .json({ code: result.code, detail: result.detail });
            return void res.status(400).json({
                detail: "Connector authorization could not be started.",
            });
        }
        res.json({
            ...result.result,
            callbackOrigin: new URL(redirectUri).origin,
        });
    }),
);

// GET /user/mcp-connectors/oauth/callback
userRouter.get("/mcp-connectors/oauth/callback", asyncRoute(async (req, res) => {
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
        res.set(mcpOAuthPopupHeaders(nonce))
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
        // The popup only ever shows a fixed, sanitized string. The operator
        // gets both the raw message and the concise diagnostic — the SDK
        // embeds entire server response bodies, including HTML error pages,
        // in its messages, so the concise form is what is actually readable.
        console.error("[user/mcp-connectors] oauth callback failed", {
            error: errorMessage(err),
            diagnostic: conciseMcpErrorMessage(err),
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
            .set(mcpOAuthPopupHeaders(nonce))
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
}));

// ---------------------------------------------------------------------------
// Native Google Drive integration (first-party, GA Drive REST API — no MCP
// preview program required). One connection per user; the popup pages reuse
// the MCP OAuth popup renderer.
// ---------------------------------------------------------------------------

// GET /user/integrations/google-drive
userRouter.get("/integrations/google-drive", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    try {
        // The card shows the exact redirect URI to register while the client
        // is not configured yet, so the operator never has to guess it. In
        // production backendPublicUrl throws without API_PUBLIC_URL; that is
        // a deployment error to report as "unknown", not a status failure.
        let redirectUri: string | null = null;
        try {
            redirectUri = `${backendPublicUrl(req)}/user/integrations/google-drive/oauth/callback`;
        } catch {
            redirectUri = null;
        }
        res.json({
            ...(await getGoogleDriveStatus(userId, createServerSupabase())),
            redirectUri,
        });
    } catch (err) {
        console.error("[google-drive] status failed", {
            userId,
            error: safeError(err),
        });
        res.status(500).json({ detail: "Failed to load Google Drive status." });
    }
});

// POST /user/integrations/google-drive/oauth/start
userRouter.post(
    "/integrations/google-drive/oauth/start",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        try {
            const redirectUri = `${backendPublicUrl(req)}/user/integrations/google-drive/oauth/callback`;
            const result = await startGoogleDriveOAuth(
                userId,
                redirectUri,
                createServerSupabase(),
            );
            res.json(result);
        } catch (err) {
            console.error("[google-drive] oauth start failed", {
                userId,
                error: safeError(err),
            });
            // Same allowlist as the MCP start route: only the repo-authored
            // setup instructions reach the browser verbatim. A DB or crypto
            // failure here must not echo its message to the client.
            if (err instanceof ConnectorSetupError) {
                return void res
                    .status(400)
                    .json({ code: err.code, detail: err.message });
            }
            res.status(400).json({
                detail: "Google Drive authorization could not be started.",
            });
        }
    },
);

// Google may return to a separate API origin that cannot receive the web
// session cookie. Relay only OAuth parameters to our fixed frontend gateway;
// completion there requires the same authenticated Mike user who started it.
for (const provider of ["google-drive", "gmail", "google-calendar"]) {
    userRouter.get(`/integrations/${provider}/oauth/callback`, (req, res) => {
        const finish = new URL(
            frontendUrl(`/api/user/integrations/${provider}/oauth/finish`),
        );
        for (const key of ["state", "code", "error"]) {
            if (typeof req.query[key] === "string")
                finish.searchParams.set(key, req.query[key]);
        }
        res.set("Cache-Control", "no-store")
            .set("Referrer-Policy", "no-referrer")
            .redirect(303, finish.toString());
    });
    userRouter.use(`/integrations/${provider}/oauth/finish`, (_req, res, next) => {
        res.set("Cache-Control", "no-store")
            .set("Referrer-Policy", "no-referrer");
        next();
    });
}

// GET /user/integrations/google-drive/oauth/finish
userRouter.get(
    "/integrations/google-drive/oauth/finish",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const nonce = crypto.randomBytes(16).toString("base64");
        const state =
            typeof req.query.state === "string" ? req.query.state : "";
        const code = typeof req.query.code === "string" ? req.query.code : "";
        const error =
            typeof req.query.error === "string" ? req.query.error : undefined;
        try {
            if (error) throw new Error(error);
            if (!state || !code)
                throw new Error("OAuth callback is missing state or code.");
            await completeGoogleDriveOAuth(
                res.locals.userId, state, code, createServerSupabase(),
            );
            res.set(mcpOAuthPopupHeaders(nonce))
                .type("html")
                .send(
                    mcpOAuthPopupHtml(
                        { success: true, connectorId: "google-drive" },
                        nonce,
                    ),
                );
        } catch (err) {
            console.error("[google-drive] oauth callback failed", {
                error: safeError(err),
                hasCode: !!code,
            });
            res.status(400)
                .set(mcpOAuthPopupHeaders(nonce))
                .type("html")
                .send(
                    mcpOAuthPopupHtml(
                        {
                            success: false,
                            detail: "Google Drive authorization could not be completed. Return to Mike and try again.",
                        },
                        nonce,
                    ),
                );
        }
    },
);

// DELETE /user/integrations/google-drive
userRouter.delete(
    "/integrations/google-drive",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        try {
            await disconnectGoogleDrive(userId, createServerSupabase());
            res.status(204).end();
        } catch (err) {
            console.error("[google-drive] disconnect failed", {
                userId,
                error: safeError(err),
            });
            res.status(500).json({
                detail: "Failed to disconnect Google Drive.",
            });
        }
    },
);

// PATCH /user/integrations/google-drive — { enabled?, requireWriteApproval? }
userRouter.patch(
    "/integrations/google-drive",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        for (const key of ["enabled", "requireWriteApproval", "readOnly"]) {
            if (req.body?.[key] !== undefined && typeof req.body[key] !== "boolean")
                return void res.status(400).json({ detail: `${key} must be a boolean.` });
        }
        const db = createServerSupabase();
        try {
            await updateGoogleDriveSettings(
                userId,
                { enabled: req.body?.enabled, requireWriteApproval: req.body?.requireWriteApproval, readOnly: req.body?.readOnly },
                db,
            );
            res.json(await getGoogleDriveStatus(userId, db));
        } catch (err) {
            console.error("[google-drive] settings update failed", {
                userId,
                error: safeError(err),
            });
            res.status(409).json({
                detail: "Google Drive settings could not be saved. Reload and try again.",
            });
        }
    }),
);

// PATCH /user/integrations/google-drive/tools/:toolName — { enabled }
userRouter.patch(
    "/integrations/google-drive/tools/:toolName",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        if (typeof req.body?.enabled !== "boolean")
            return void res
                .status(400)
                .json({ detail: "enabled must be a boolean." });
        const db = createServerSupabase();
        try {
            await setGoogleDriveToolEnabled(
                userId,
                String(req.params.toolName),
                req.body.enabled,
                db,
            );
            res.json(await getGoogleDriveStatus(userId, db));
        } catch (err) {
            console.error("[google-drive] tool update failed", {
                userId,
                error: safeError(err),
            });
            res.status(409).json({
                detail: "Google Drive tool settings could not be saved. Reload and try again.",
            });
        }
    }),
);

// Cancel only this user's pending attempt; never disconnect an existing grant.
userRouter.post(
    "/integrations/google-drive/oauth/cancel",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const state = req.body?.state;
        if (typeof state !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(state)) {
            return void res
                .status(400)
                .json({
                    detail: "Invalid Google Drive authorization attempt.",
                });
        }
        try {
            await cancelGoogleDriveOAuth(
                res.locals.userId as string,
                state,
                createServerSupabase(),
            );
            res.status(204).end();
        } catch (error) {
            console.error(
                "[google-drive] cancellation failed",
                safeError(error),
            );
            res.status(500).json({
                detail: "Google Drive authorization could not be cancelled. Close the Google window and try again.",
            });
        }
    }),
);


// Gmail and Calendar are explicit integrations, independent of sign-in.
for (const provider of ["gmail", "google-calendar"] as const) {
    const path = `/integrations/${provider}`;
    const callback = (req: Parameters<typeof backendPublicUrl>[0]) =>
        `${backendPublicUrl(req)}/user${path}/oauth/callback`;
    const report = (error: unknown) => {
        console.error("[google-workspace] request failed", safeError(error));
        return error instanceof GoogleWorkspaceError
            ? error.message
            : "Google integration request failed. Please try again.";
    };
    userRouter.get(
        path,
        requireAuth,
        asyncRoute(async (req, res) => {
            let redirectUri: string | null = null;
            try {
                redirectUri = callback(req);
            } catch {
                /* deployment config absent */
            }
            try {
                res.json({
                    ...(await workspaceConnectorStatus(
                        createServerSupabase(),
                        res.locals.userId,
                        provider,
                    )),
                    redirectUri,
                });
            } catch (error) {
                res.status(500).json({ detail: report(error) });
            }
        }),
    );
    userRouter.post(
        `${path}/oauth/start`,
        requireAuth,
        requireMfaIfEnrolled,
        asyncRoute(async (req, res) => {
            try {
                res.json(
                    await startWorkspaceOAuth(
                        createServerSupabase(),
                        res.locals.userId,
                        provider,
                        callback(req),
                    ),
                );
            } catch (error) {
                // As for Slack and Drive: only repo-authored setup steps reach
                // the browser verbatim, under their machine-readable code.
                if (error instanceof ConnectorSetupError) {
                    console.error("[google-workspace] setup required", {
                        provider,
                    });
                    return void res
                        .status(400)
                        .json({ code: error.code, detail: error.message });
                }
                res.status(400).json({ detail: report(error) });
            }
        }),
    );
    userRouter.get(
        `${path}/oauth/finish`,
        requireAuth,
        requireMfaIfEnrolled,
        asyncRoute(async (req, res) => {
            const nonce = crypto.randomBytes(16).toString("base64");
            res.set(mcpOAuthPopupHeaders(nonce)).type(
                "html",
            );
            try {
                if (
                    req.query.error ||
                    typeof req.query.state !== "string" ||
                    typeof req.query.code !== "string"
                )
                    throw new GoogleWorkspaceError(
                        "Google authorization was cancelled or incomplete.",
                    );
                await completeWorkspaceOAuth(
                    createServerSupabase(),
                    res.locals.userId,
                    provider,
                    req.query.state,
                    req.query.code,
                );
                res.send(
                    mcpOAuthPopupHtml(
                        { success: true, connectorId: provider },
                        nonce,
                    ),
                );
            } catch (error) {
                report(error);
                res.status(400).send(
                    mcpOAuthPopupHtml(
                        {
                            success: false,
                            detail: "Google authorization could not be completed. Return to Mike and try again.",
                        },
                        nonce,
                    ),
                );
            }
        }),
    );
    userRouter.post(
        `${path}/oauth/cancel`,
        requireAuth,
        requireMfaIfEnrolled,
        asyncRoute(async (req, res) => {
            if (
                typeof req.body?.state !== "string" ||
                !/^[A-Za-z0-9_-]{32}$/.test(req.body.state)
            )
                return void res
                    .status(400)
                    .json({ detail: "Invalid authorization attempt." });
            try {
                await cancelWorkspaceOAuth(
                    createServerSupabase(),
                    res.locals.userId,
                    provider,
                    req.body.state,
                );
                res.status(204).end();
            } catch (error) {
                res.status(500).json({ detail: report(error) });
            }
        }),
    );
    // PATCH /user/integrations/:provider — { enabled?, requireWriteApproval? }
    userRouter.patch(
        path,
        requireAuth,
        requireMfaIfEnrolled,
        asyncRoute(async (req, res) => {
            const body = req.body ?? {};
            for (const key of ["enabled", "requireWriteApproval", "readOnly"]) {
                if (body[key] !== undefined && typeof body[key] !== "boolean")
                    return void res
                        .status(400)
                        .json({ detail: `${key} must be a boolean.` });
            }
            const db = createServerSupabase();
            try {
                await updateWorkspaceSettings(db, res.locals.userId, provider, {
                    enabled: body.enabled,
                    requireWriteApproval: body.requireWriteApproval,
                    readOnly: body.readOnly,
                });
                res.json(
                    await workspaceConnectorStatus(
                        db,
                        res.locals.userId,
                        provider,
                    ),
                );
            } catch (error) {
                res.status(409).json({ detail: report(error) });
            }
        }),
    );
    // PATCH /user/integrations/:provider/tools/:toolName — { enabled }
    userRouter.patch(
        `${path}/tools/:toolName`,
        requireAuth,
        requireMfaIfEnrolled,
        asyncRoute(async (req, res) => {
            const toolName = String(req.params.toolName);
            if (typeof req.body?.enabled !== "boolean")
                return void res
                    .status(400)
                    .json({ detail: "enabled must be a boolean." });
            if (!workspaceToolList(provider, null).some((t) => t.name === toolName))
                return void res.status(404).json({ detail: "Unknown tool." });
            const db = createServerSupabase();
            try {
                await setWorkspaceToolEnabled(
                    db,
                    res.locals.userId,
                    provider,
                    toolName,
                    req.body.enabled,
                );
                res.json(
                    await workspaceConnectorStatus(
                        db,
                        res.locals.userId,
                        provider,
                    ),
                );
            } catch (error) {
                res.status(409).json({ detail: report(error) });
            }
        }),
    );
    userRouter.delete(
        path,
        requireAuth,
        requireMfaIfEnrolled,
        asyncRoute(async (_req, res) => {
            try {
                await disconnectWorkspace(
                    createServerSupabase(),
                    res.locals.userId,
                    provider,
                );
                res.status(204).end();
            } catch (error) {
                res.status(500).json({ detail: report(error) });
            }
        }),
    );
}
// POST /user/mcp-connectors/:connectorId/refresh-tools
userRouter.post(
    "/mcp-connectors/:connectorId/refresh-tools",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await refreshMcpConnectorTools(
            db,
            userId,
            req.params.connectorId,
        );
        if (!result.ok) {
            // NOT a 401: since authentication moved to HttpOnly cookies the
            // browser treats every 401 from this API as "your Mike session is
            // gone" and logs the user out (frontend authenticatedFetch). This
            // is the UPSTREAM server wanting authorization, and the Mike
            // session is fine — 409 says "the connector is not in a state
            // where tools can be listed"; the client keys on `code`.
            if (result.kind === "oauth_required")
                return void res.status(409).json({
                    code: result.code,
                    detail: "This connector needs to be authorized again.",
                });
            return void res.status(400).json({
                detail: "Connector tools could not be refreshed.",
            });
        }
        res.json(result.connector);
    }),
);

// PATCH /user/mcp-connectors/:connectorId/tools/:toolId
userRouter.patch(
    "/mcp-connectors/:connectorId/tools/:toolId",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
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
    }),
);

// DELETE /user/account
userRouter.delete(
    "/account",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const token = res.locals.token as string | undefined;
        const db = createServerSupabase();
        const result = await deleteUserAccount(db, userId, userEmail, token);
        if (!result.ok) {
            if ("kind" in result && result.kind === "org_successor_required")
                return void res.status(409).json({
                    code: "org_successor_required",
                    detail: describeAccountDeletionBlockers(result.blockers),
                    organizations: result.blockers,
                });
            return void sendInternalError(res, result.error);
        }
        res.status(204).send();
    }),
);

// DELETE /user/chats
userRouter.delete(
    "/chats",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await deleteUserChats(db, userId);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    }),
);

// DELETE /user/projects
userRouter.delete(
    "/projects",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await deleteUserProjectsData(db, userId);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    }),
);

// DELETE /user/tabular-reviews
userRouter.delete(
    "/tabular-reviews",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const result = await deleteUserTabularReviews(db, userId);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    }),
);

// DELETE /user/memories
// Wipes the user's app memory and memories belonging to private projects they
// created. Organization and merely shared projects are intentionally outside
// this account-level destructive action.
userRouter.delete(
    "/memories",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (_req, res) => {
        const userId = res.locals.userId as string;
        const result = await deletePrivateMemories(createServerSupabase(), userId);
        if (!result.ok) return void sendInternalError(res, result.error);
        res.status(204).send();
    }),
);

// ---------------------------------------------------------------------------
// Async exports (durable): POST creates a DB-queue job that builds the
// export off the request thread; GET polls it; the download endpoint streams
// the finished artifact, so a large export can neither time out the request
// nor die with a dropped tab.
// Artifacts expire after 24 hours (the runner's retention sweep deletes the
// file and the job row).

// POST /user/exports  { type, params? }
userRouter.post(
    "/exports",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
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
        // operator turns the runner back on. Refuse instead: exports answer
        // 503 until the runner is enabled (production must keep it on; see
        // docs/memory.md).
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
    }),
);

// GET /user/exports/:exportId — poll until status is "done", then fetch
// GET /user/exports/:exportId/download.
userRouter.get(
    "/exports/:exportId",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
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
    }),
);

// GET /user/exports/:exportId/download — stream the finished artifact.
// Authenticated + ownership-checked on every request (unlike /download/:token,
// which only serves paths backed by a document_versions row and would 404 on
// an export artifact); artifacts expire after 24h.
userRouter.get(
    "/exports/:exportId/download",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
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
    }),
);

userRouter.use(routerErrorHandler("[user]"));
