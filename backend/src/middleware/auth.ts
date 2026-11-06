import { Request, Response, NextFunction } from "express";
import type { ParamsFlatDictionary } from "express-serve-static-core";
import { createServerSupabase, type Db } from "../lib/supabase";
import { syncProfileEmail } from "../lib/userLookup";
import { sendInternalError, sendUpstreamUnavailable } from "../lib/httpError";
import { isAuthUpstreamFailure } from "../lib/authUpstream";
import { noteUpstreamReachable } from "../lib/upstreamOutage";
import { clearRequestAuthCookies, createRequestSupabase } from "../lib/authSession";
import { reportSchemaOutOfDateOnce } from "../lib/schemaOutOfDate";
import { requestOriginIsTrusted } from "../lib/origins";
import { devLog, isDev } from "../lib/log";
import { AppError } from "../lib/appError";
import {
  reportError,
  requestRoutePattern,
  setCurrentUser,
} from "../lib/observability/sentry";

/**
 * Supabase could not say which assurance level the session has. That is an
 * outage or a misconfiguration on our side, not a sign-out, so it is reported
 * under its own kind (a warning: the user is asked to sign in again and can
 * recover) before the client gets the answer it always did.
 */
function reportMfaAssuranceFailure(req: Request, error: unknown): AppError {
  const failure = new AppError(
    "auth.mfa_assurance_failed",
    "MFA assurance level lookup failed",
    { cause: error },
  );
  reportError(failure, {
    level: "warning",
    tags: {
      component: "http",
      http_method: req.method,
      http_route: requestRoutePattern(req),
    },
  });
  return failure;
}

function summarizeMfaFactors(
  factors: Array<{
    factor_type?: string;
    status?: string;
  }> | null | undefined,
) {
  return (factors ?? []).map((factor) => ({
    type: factor.factor_type ?? "unknown",
    status: factor.status ?? "unknown",
  }));
}

function isLoginMfaBootstrapRoute(req: Request) {
  const path = req.originalUrl.split("?")[0];
  if (path === "/auth/session" || path.startsWith("/auth/mfa/")) {
    return true;
  }
  return (
    (req.method === "GET" || req.method === "POST") &&
    path === "/user/profile"
  );
}

// user_profiles.mfa_on_login missing (42703) means a deployment that has not
// run the migration yet. Enforcement cannot apply without the preference, so
// the request proceeds for compatibility — but it must not be silent. 42703
// is a schema-out-of-date code, so this goes through the same once-per-process
// gate as every other missing migration (lib/schemaOutOfDate.ts): one
// error-level schema_out_of_date event, then an hourly log reminder, and no
// second once-flag that could report the same missing column again.
function reportLoginMfaColumnMissing(error: { code?: string }) {
  reportSchemaOutOfDateOnce(error, {
    key: "auth.login_mfa_preference",
    // requireAuth runs before any handler names the flow, so name it here:
    // without it the event reads as any other missing column, not as login
    // MFA silently not being enforced.
    tags: { component: "http", operation: "auth.login_mfa" },
    consequence: "login MFA enforcement is not active until the migration runs",
  });
}

async function enforceLoginMfaIfEnabled(
  req: Request,
  res: Response,
  admin: Db,
  token: string,
) {
  if (isLoginMfaBootstrapRoute(req)) return true;

  const { data, error } = await admin
    .from("user_profiles")
    .select("mfa_on_login")
    .eq("user_id", res.locals.userId)
    .maybeSingle();

  if (error) {
    devLog("[auth/mfa] login preference lookup failed", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      userId: res.locals.userId,
      error: error.message,
      code: error.code,
    });
    if (error.code === "42703") {
      reportLoginMfaColumnMissing(error);
      return true;
    }
    sendInternalError(
      res,
      new AppError("db.query_failed", "login MFA preference lookup failed", {
        cause: error,
      }),
    );
    return false;
  }

  const profile = data as { mfa_on_login?: boolean } | null;
  if (profile?.mfa_on_login !== true) return true;

  const { data: assurance, error: assuranceError } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (assuranceError) {
    devLog("[auth/mfa] login assurance lookup failed", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      userId: res.locals.userId,
      error: assuranceError.message,
    });
    console.error(
      "[auth/mfa] login assurance lookup failed",
      reportMfaAssuranceFailure(req, assuranceError),
    );
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return false;
  }

  if (assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2") {
    devLog("[auth/mfa] login verification required", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return false;
  }

  return true;
}

function getAdminClient(res: Response) {
  try {
    return createServerSupabase();
  } catch (error) {
    // No admin client means no request can authenticate: report the
    // configuration failure once, with the route it refused.
    sendInternalError(
      res,
      new AppError("auth.supabase_unavailable", "Server auth is not configured", {
        cause: error,
      }),
    );
    return null;
  }
}

/**
 * The name and status of an auth-js error, or null for anything else.
 * Duck-typed like lib/authUpstream.ts, on auth-js's `__isAuthError` marker,
 * so it holds for any auth-js copy and for tests that stub supabase-js.
 */
function authErrorShape(error: unknown): { name: unknown; status: number } | null {
  if (!error || typeof error !== "object" || !("__isAuthError" in error)) return null;
  const { name, status } = error as { name?: unknown; status?: unknown };
  return { name, status: typeof status === "number" ? status : 0 };
}

export async function requireAuth(
  req: Request<ParamsFlatDictionary>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const admin = getAdminClient(res);
  if (!admin) return;

  let token = "";
  let user: Awaited<ReturnType<typeof admin.auth.getUser>>["data"]["user"] =
    null;
  // auth-js returns, rather than throws, the error behind a missing user.
  let lookupError: unknown = null;

  if (auth.startsWith("Bearer ")) {
    // Temporary compatibility path for older Word add-ins, load tests, and
    // API clients. Updated browser clients authenticate with HttpOnly cookies.
    token = auth.slice(7).trim();
    const result = await admin.auth.getUser(token);
    user = result.data.user;
    lookupError = result.error;
  } else {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !requestOriginIsTrusted(req.get("origin"))
    ) {
      res.status(403).json({
        code: "untrusted_origin",
        detail: "The request origin is not allowed.",
      });
      return;
    }

    try {
      const authClient = createRequestSupabase(req, res);
      const result = await authClient.auth.getUser();
      user = result.data.user;
      lookupError = result.error;
      if (user) {
        const sessionResult = await authClient.auth.getSession();
        token = sessionResult.data.session?.access_token ?? "";
        res.locals.authClient = authClient;
        res.locals.authSource = "cookie";
      }
    } catch (error) {
      sendInternalError(
        res,
        new AppError(
          "auth.session_lookup_failed",
          "cookie session initialization failed",
          { cause: error },
        ),
      );
      return;
    }
  }

  const failure = user ? null : authErrorShape(lookupError);
  if (failure) {
    if (isAuthUpstreamFailure(lookupError)) {
      // GoTrue could not be reached, so nobody could say whether the session
      // is valid. A 401 would sign the user out of a session that may be
      // fine; a 503 tells the client to wait and retry.
      // The handler that would name this request's flow never runs, so the
      // event is named after what failed: the session lookup.
      sendUpstreamUnavailable(
        res,
        new AppError("auth.supabase_unavailable", "session lookup could not reach GoTrue", {
          cause: lookupError,
        }),
        { operation: "auth.session" },
      );
      return;
    }
    const { name, status } = failure;
    if (name === "AuthApiError" && status >= 400 && status < 500) {
      // GoTrue refused the session (a refresh token revoked or already used,
      // a JWT for a session that no longer exists): the visitor must sign in
      // again, which is a 401 the client already handles. Clear the dead
      // cookies so the next request does not present them again.
      if (!auth.startsWith("Bearer ")) clearRequestAuthCookies(req, res);
      res.status(401).json({ code: "session_expired", detail: "Invalid or expired session" });
      return;
    }
    if (status >= 500) {
      // GoTrue answered, with a failure of its own (a 500 from its database,
      // a malformed token response): our bug to fix, not a sign-out.
      sendInternalError(
        res,
        new AppError("auth.supabase_unavailable", "session lookup failed in GoTrue", {
          cause: lookupError,
        }),
      );
      return;
    }
  }
  // GoTrue answered: an outage reported earlier is over.
  if (user) noteUpstreamReachable();

  if (!user || !token) {
    res.status(401).json({ detail: "Invalid or expired session" });
    return;
  }

  const { data: deletionProfile, error: deletionError } = await admin
    .from("user_profiles")
    .select("account_deletion_requested_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (deletionError) {
    sendInternalError(
      res,
      new AppError("db.query_failed", "account deletion state lookup failed", {
        cause: deletionError,
      }),
    );
    return;
  }
  if (deletionProfile?.account_deletion_requested_at) {
    res.status(401).json({ code: "account_deletion_pending", detail: "This account is being deleted." });
    return;
  }

  res.locals.userId = user.id;
  // `userEmail` is an AUTHORIZATION input, not a display value: direct grants
  // (projects, chats, reviews, workflows) and organization invitations are
  // all matched against it. An address the account has not proved it owns
  // must therefore match nothing — otherwise signing up as someone else's
  // address (before they do) inherits whatever was shared or extended to it.
  // Such a session still authenticates; it only stops matching email-keyed
  // grants until the address is confirmed.
  res.locals.userEmail =
    user.email && user.email_confirmed_at ? user.email.toLowerCase() : "";
  res.locals.token = token;
  // Id only — enough for "how many users are affected", never the email.
  setCurrentUser(user.id);
  const syncError = await syncProfileEmail(
    admin,
    user.id,
    user.email,
  );
  if (syncError) {
    devLog("[auth/profile-email] sync failed", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      userId: user.id,
      error: syncError.message,
    });
  }
  if (!(await enforceLoginMfaIfEnabled(req, res, admin, token))) {
    return;
  }
  next();
}

export async function requireMfaIfEnrolled(
  req: Request<ParamsFlatDictionary>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = typeof res.locals.token === "string" ? res.locals.token : "";
  if (!token) {
    devLog("[auth/mfa] missing auth session", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
    });
    res.status(401).json({ detail: "Missing auth session" });
    return;
  }

  const admin = getAdminClient(res);
  if (!admin) return;
  const { data, error } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (error) {
    devLog("[auth/mfa] assurance lookup failed", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      userId: res.locals.userId,
      error: error.message,
    });
    console.error(
      "[auth/mfa] assurance lookup failed",
      reportMfaAssuranceFailure(req, error),
    );
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return;
  }

  devLog("[auth/mfa] assurance level", {
    method: req.method,
    path: req.originalUrl.split("?")[0],
    userId: res.locals.userId,
    currentLevel: data.currentLevel,
    nextLevel: data.nextLevel,
    required: data.nextLevel === "aal2" && data.currentLevel !== "aal2",
  });

  if (isDev) {
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    devLog("[auth/mfa] user factors", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      userId: res.locals.userId,
      factorCount: userData.user?.factors?.length ?? 0,
      factors: summarizeMfaFactors(userData.user?.factors),
      error: userError?.message ?? null,
    });
  }

  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    devLog("[auth/mfa] verification required", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return;
  }

  next();
}
