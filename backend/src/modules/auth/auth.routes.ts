// HTTP layer for the auth module.
//
// Everything that genuinely needs req/res lives here: creating the
// cookie-bearing Supabase client, clearing auth cookies, reading the request
// origin, and rendering GoTrue's errors as safe responses. The payload
// schemas, the redirect-URL construction, and the GoTrue calls themselves are
// in auth.service.ts.

import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  clearRequestAuthCookies,
  createRequestSupabase,
  publicAuthUser,
} from "../../lib/authSession";
import { ssoConfiguration, ssoDomainSchema } from "../../lib/ssoConfig";
import { sendInternalError } from "../../lib/httpError";
import { requestOriginIsWordAddin } from "../../lib/origins";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { requireTrustedOrigin } from "../../middleware/trustedOrigin";
import {
  applyHandoffSession,
  buildCallbackUrl,
  challengeAndVerifyMfa,
  challengeMfaFactor,
  consumeWordHandoff,
  credentialsSchema,
  currentUser,
  emailSchema,
  enrollMfaFactor,
  exchangeCodeForSession,
  exchangeSchema,
  factorSchema,
  friendlyNameSchema,
  handoffSchema,
  issueWordHandoff,
  listMfaFactors,
  mfaAssuranceLevel,
  passwordSchema,
  sendPasswordReset,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  startGoogleOAuth,
  ssoRequestSchema,
  startSsoSignIn,
  unenrollMfaFactor,
  updateEmail,
  updatePassword,
  verificationSchema,
  verifyMfaChallenge,
  signupSchema,
} from "./auth.service";
import {
  describeAuthProviderError,
  describeAuthValidationIssues,
} from "./auth.messages";

export const authRouter = Router();

authRouter.use(requireTrustedOrigin);
authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

function requestOrigin(req: Request): string {
  return new URL(req.get("origin") as string).origin;
}

function callbackUrl(
  req: Request,
  next: unknown,
  fallback: string,
  path = "/auth/callback",
): string {
  return buildCallbackUrl(requestOrigin(req), next, fallback, path);
}

function authError(
  res: Response,
  error: unknown,
  fallback = "Authentication could not be completed.",
) {
  const wire = describeAuthProviderError(error, fallback);
  if (wire.status >= 500) {
    console.error(
      "[auth] unexpected server-side authentication failure",
      error,
    );
  }
  res.status(wire.status).json({ code: wire.code, detail: wire.detail });
}

function invalidBody(
  res: Response,
  issues?: ReadonlyArray<{ path: PropertyKey[]; code: string; message?: string }>,
) {
  res.status(400).json(describeAuthValidationIssues(issues ?? []));
}

function cookieClient(req: Request, res: Response): SupabaseClient | null {
  const client = res.locals.authClient as SupabaseClient | undefined;
  if (!client || res.locals.authSource !== "cookie") {
    res.status(401).json({
      code: "cookie_session_required",
      detail: "A cookie-authenticated session is required.",
    });
    return null;
  }
  return client;
}

authRouter.post("/login", asyncRoute(async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues);

  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await signInWithPassword(client, parsed.data);
    if (error || !data.user || !data.session) return authError(res, error);
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error);
  }
}));

authRouter.post("/signup", asyncRoute(async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues);

  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await signUpWithPassword(
      client,
      parsed.data,
      callbackUrl(req, req.body?.next, "/onboarding/profile"),
    );
    if (error || !data.user) return authError(res, error);
    res.status(201).json({
      user: publicAuthUser(data.user),
      requiresEmailConfirmation: !data.session,
    });
  } catch (error) {
    authError(res, error);
  }
}));

async function startSso(req: Request, res: Response) {
  try {
    const config = ssoConfiguration();
    if (!config.enabled) {
      return res
        .status(403)
        .json({
          code: "sso_disabled",
          detail: "Single sign-on is not enabled.",
        });
    }
    const parsed = ssoRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalidBody(res);
    const emailDomain = parsed.data.email.slice(
      parsed.data.email.lastIndexOf("@") + 1,
    );
    const parsedDomain = ssoDomainSchema.safeParse(emailDomain);
    if (!parsedDomain.success) return invalidBody(res);
    const domain = parsedDomain.data;
    if (config.allowedDomains && !config.allowedDomains.includes(domain)) {
      return res
        .status(400)
        .json({
          code: "sso_domain_not_allowed",
          detail: "Single sign-on is not available for this domain.",
        });
    }
    const client = createRequestSupabase(req, res);
    const { data, error } = await startSsoSignIn(
      client,
      domain,
      callbackUrl(req, req.body?.next, "/onboarding/profile"),
    );
    if (error) {
      if (error.status && error.status >= 400 && error.status < 500) {
        return res
          .status(400)
          .json({
            code: "sso_unavailable",
            detail: "Unable to start single sign-on for this domain.",
          });
      }
      throw new Error("SSO provider request failed");
    }
    if (!data?.url) throw new Error("Missing SSO redirect");
    return res.json({ url: data.url });
  } catch {
    return sendInternalError(
      res,
      new Error("SSO sign-in could not be started"),
    );
  }
}

authRouter.post("/oauth", asyncRoute(async (req, res) => {
  if (req.body?.provider === "sso") return startSso(req, res);
  if (req.body?.provider !== "google") return invalidBody(res);
  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await startGoogleOAuth(
      client,
      callbackUrl(
        req,
        req.body?.next,
        "/onboarding/profile",
        req.body?.callbackPath === "/oauth-dialog.html"
          ? "/oauth-dialog.html"
          : "/auth/callback",
      ),
    );
    if (error || !data.url) return authError(res, error);
    res.json({ url: data.url });
  } catch (error) {
    authError(res, error);
  }
}));

authRouter.post("/exchange", asyncRoute(async (req, res) => {
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  try {
    const client = createRequestSupabase(req, res);
    const { data, error } = await exchangeCodeForSession(
      client,
      parsed.data.code,
    );
    if (error || !data.user || !data.session) return authError(res, error);
    if (parsed.data.handoffRequestId) {
      if (!requestOriginIsWordAddin(req.get("origin"))) {
        res.status(403).json({
          code: "word_handoff_origin_required",
          detail: "The authentication handoff origin is not allowed.",
        });
        return;
      }
      const handoffTicket = await issueWordHandoff({
        userId: data.user.id,
        requestId: parsed.data.handoffRequestId,
        origin: requestOrigin(req),
        session: data.session,
      });
      res.json({ handoffTicket });
      return;
    }
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error);
  }
}));

authRouter.post("/handoff", asyncRoute(async (req, res) => {
  const parsed = handoffSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  if (!requestOriginIsWordAddin(req.get("origin"))) {
    res.status(403).json({
      code: "word_handoff_origin_required",
      detail: "The authentication handoff origin is not allowed.",
    });
    return;
  }

  try {
    const handoff = await consumeWordHandoff({
      ticket: parsed.data.ticket,
      requestId: parsed.data.requestId,
      origin: requestOrigin(req),
    });
    if (!handoff) {
      res.status(400).json({
        code: "invalid_auth_handoff",
        detail: "This authentication handoff is invalid or has expired.",
      });
      return;
    }

    const client = createRequestSupabase(req, res);
    const { data, error } = await applyHandoffSession(client, {
      accessToken: handoff.accessToken,
      refreshToken: handoff.refreshToken,
    });
    if (
      error ||
      !data.user ||
      !data.session ||
      data.user.id !== handoff.userId
    ) {
      clearRequestAuthCookies(req, res);
      return authError(
        res,
        error,
        "Authentication handoff could not be completed.",
      );
    }
    res.json({ user: publicAuthUser(data.user) });
  } catch (error) {
    authError(res, error, "Authentication handoff could not be completed.");
  }
}));

authRouter.post("/password-reset", asyncRoute(async (req, res) => {
  const email = emailSchema.safeParse(req.body?.email);
  if (email.success) {
    try {
      const client = createRequestSupabase(req, res);
      await sendPasswordReset(
        client,
        email.data,
        callbackUrl(req, "/reset-password", "/reset-password"),
      );
    } catch {
      // Deliberately indistinguishable to prevent account enumeration.
    }
  }
  res.status(204).end();
}));

authRouter.get("/session", requireAuth, asyncRoute(async (_req, res) => {
  const client = cookieClient(_req, res);
  if (!client) return;
  const { user, error } = await currentUser(client);
  if (error || !user) return authError(res, error);
  res.json({ user: publicAuthUser(user) });
}));

authRouter.post("/logout", asyncRoute(async (req, res) => {
  try {
    const client = createRequestSupabase(req, res);
    await signOut(client, req.body?.scope === "global" ? "global" : "local");
  } catch (error) {
    // Local cookie removal must not depend on the upstream revocation request.
    console.error("[auth/logout] upstream sign-out failed", error);
  } finally {
    clearRequestAuthCookies(req, res);
  }
  res.status(204).end();
}));

authRouter.patch("/email", requireAuth, asyncRoute(async (req, res) => {
  const email = emailSchema.safeParse(req.body?.email);
  if (!email.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await updateEmail(
    client,
    email.data,
    callbackUrl(req, req.body?.next, "/settings?emailChange=processed"),
  );
  if (error || !data.user) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.patch("/password", requireAuth, asyncRoute(async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await updatePassword(client, parsed.data.password);
  if (error || !data.user) return authError(res, error);
  if (parsed.data.signOut) {
    await signOut(client, "global");
    clearRequestAuthCookies(req, res);
  }
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.get("/mfa/factors", requireAuth, asyncRoute(async (req, res) => {
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await listMfaFactors(client);
  if (error) return authError(res, error);
  res.json(data);
}));

authRouter.get("/mfa/assurance", requireAuth, asyncRoute(async (req, res) => {
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await mfaAssuranceLevel(client);
  if (error) return authError(res, error);
  res.json(data);
}));

authRouter.post("/mfa/enroll", requireAuth, asyncRoute(async (req, res) => {
  const friendlyName = friendlyNameSchema.safeParse(req.body?.friendlyName);
  if (!friendlyName.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await enrollMfaFactor(client, friendlyName.data);
  if (error) return authError(res, error);
  res.status(201).json(data);
}));

authRouter.post("/mfa/challenge", requireAuth, asyncRoute(async (req, res) => {
  const parsed = factorSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await challengeMfaFactor(client, parsed.data);
  if (error) return authError(res, error);
  res.json(data);
}));

authRouter.post("/mfa/verify", requireAuth, asyncRoute(async (req, res) => {
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.challengeId) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await verifyMfaChallenge(client, {
    factorId: parsed.data.factorId,
    challengeId: parsed.data.challengeId,
    code: parsed.data.code,
  });
  if (error) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.post("/mfa/challenge-and-verify", requireAuth, asyncRoute(async (req, res) => {
  const parsed = verificationSchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await challengeAndVerifyMfa(client, {
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });
  if (error) return authError(res, error);
  res.json({ user: publicAuthUser(data.user) });
}));

authRouter.delete("/mfa/factors/:factorId", requireAuth, asyncRoute(async (req, res) => {
  const parsed = factorSchema.safeParse({ factorId: req.params.factorId });
  if (!parsed.success) return invalidBody(res);
  const client = cookieClient(req, res);
  if (!client) return;
  const { data, error } = await unenrollMfaFactor(client, parsed.data);
  if (error) return authError(res, error);
  res.json(data);
}));

authRouter.use(routerErrorHandler("[auth]"));
