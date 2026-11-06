import type { Request, Response } from "express";
import {
  createServerClient,
  parseCookieHeader,
  serializeCookieHeader,
  type CookieOptions,
} from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { requestOriginIsWordAddin } from "./origins";
import { supabaseSessionConfiguration } from "./runtimeConfig";
import { singleFlightRefreshFetch } from "./authRefresh";
import { AppError } from "./appError";
import { requestRoutePattern } from "./observability/sentry";

const AUTH_COOKIE_BASE_NAME = "mike-session";
const refreshFetch = singleFlightRefreshFetch();

function authConfiguration() {
  const { url, key } = supabaseSessionConfiguration();

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) must be set",
    );
  }
  return { url, key };
}

export function authCookiesAreSecure(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === "production";
}

export function authCookieName(env: NodeJS.ProcessEnv = process.env): string {
  return `${authCookiesAreSecure(env) ? "__Host-" : ""}${AUTH_COOKIE_BASE_NAME}`;
}

function appendCookie(
  res: Response,
  name: string,
  value: string,
  options: CookieOptions,
) {
  res.append("Set-Cookie", serializeCookieHeader(name, value, options));
}

function requestCookieOptions(
  req: Request,
): Pick<
  CookieOptions,
  "httpOnly" | "secure" | "sameSite" | "path" | "partitioned"
> {
  const wordAddin = requestOriginIsWordAddin(req.get("origin"));
  return {
    httpOnly: true,
    secure: wordAddin || authCookiesAreSecure(),
    sameSite: wordAddin ? "none" : "lax",
    path: "/",
    partitioned: wordAddin || undefined,
  };
}

function belongsToAuthStorage(name: string, baseName: string): boolean {
  return (
    name === baseName ||
    name.startsWith(`${baseName}.`) ||
    name.startsWith(`${baseName}-`)
  );
}

export function clearRequestAuthCookies(req: Request, res: Response): void {
  const baseName = authCookieName();
  const cookies = parseCookieHeader(req.headers.cookie ?? "");
  const cookieOptions = requestCookieOptions(req);
  for (const { name } of cookies) {
    if (!belongsToAuthStorage(name, baseName)) continue;
    appendCookie(res, name, "", {
      ...cookieOptions,
      maxAge: 0,
      expires: new Date(0),
    });
  }
  res.setHeader(
    "Cache-Control",
    "private, no-cache, no-store, must-revalidate, max-age=0",
  );
}

/**
 * Creates an isolated Supabase client for one HTTP request. Session and PKCE
 * state are stored only in server-set HttpOnly cookies; no browser Supabase
 * client is involved.
 */
export function createRequestSupabase(
  req: Request,
  res: Response,
): SupabaseClient {
  const { url, key } = authConfiguration();
  const cookieOptions = requestCookieOptions(req);
  return createServerClient(url, key, {
    cookieOptions: {
      name: authCookieName(),
      ...cookieOptions,
    },
    cookies: {
      getAll() {
        return parseCookieHeader(req.headers.cookie ?? "");
      },
      setAll(cookiesToSet, responseHeaders) {
        // GoTrue can announce a session change after this request's
        // response has started. Writing then throws ERR_HTTP_HEADERS_SENT
        // inside GoTrue's subscriber loop, which rethrows it out of
        // getUser() as a 500. Nothing can still reach this response, so
        // skip the write. The browser keeps the refresh token that was just
        // rotated: its next request works only if GoTrue still accepts that
        // token (inside its reuse interval) or joins a refresh in flight;
        // after that GoTrue refuses it and the user signs in again. Still
        // better than the 500 it replaces. The route is logged so operators
        // can see how often a session is lost this way.
        if (res.headersSent) {
          console.warn(
            "[auth] session cookies changed after the response was sent",
            { route: requestRoutePattern(req) },
            new AppError("auth.cookie_write_after_response", "session cookie write skipped: response already sent"),
          );
          return;
        }
        for (const { name, value, options } of cookiesToSet) {
          appendCookie(res, name, value, {
            ...options,
            ...cookieOptions,
          });
        }
        for (const [name, value] of Object.entries(responseHeaders)) {
          res.setHeader(name, value);
        }
      },
    },
    // Parallel requests holding one expired session share a single refresh.
    global: { fetch: refreshFetch },
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });
}

export interface PublicAuthUser {
  id: string;
  email: string;
  pendingEmail: string | null;
  createdWithGoogle: boolean;
}

export function publicAuthUser(user: User): PublicAuthUser {
  return {
    id: user.id,
    email: user.email ?? "",
    pendingEmail: user.new_email ?? null,
    createdWithGoogle: user.app_metadata?.provider === "google",
  };
}
