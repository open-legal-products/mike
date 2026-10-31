import { Request, Response, NextFunction } from "express";
import type { ParamsFlatDictionary } from "express-serve-static-core";
import { createServerSupabase, type Db } from "../lib/supabase";
import { syncProfileEmail } from "../lib/userLookup";
import { sendInternalError } from "../lib/httpError";
import { createRequestSupabase } from "../lib/authSession";
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
// the request proceeds for compatibility — but it must not be silent: report
// once per process so operators see that login MFA is not active until the
// migration lands.
let loginMfaColumnMissingReported = false;

function reportLoginMfaColumnMissing(error: { code?: string }) {
  if (loginMfaColumnMissingReported) return;
  loginMfaColumnMissingReported = true;
  reportError(
    new AppError(
      "auth.login_mfa_column_missing",
      "user_profiles.mfa_on_login is missing; login MFA enforcement is not active until the migration runs",
      { cause: error },
    ),
    { level: "warning", tags: { component: "http" } },
  );
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

  if (auth.startsWith("Bearer ")) {
    // Temporary compatibility path for older Word add-ins, load tests, and
    // API clients. Updated browser clients authenticate with HttpOnly cookies.
    token = auth.slice(7).trim();
    const result = await admin.auth.getUser(token);
    user = result.data.user;
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
