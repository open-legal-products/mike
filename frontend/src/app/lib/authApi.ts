import {
    reportApiFailure,
    reportNetworkFailure,
} from "@/app/lib/errorReporting";
import { isAbortError } from "@/shared/lib/userError";

export interface AuthUser {
    id: string;
    email: string;
    pendingEmail: string | null;
    createdWithGoogle: boolean;
}

export interface MfaFactor {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
    status?: string;
}

export class AuthApiError extends Error {
    status: number;
    code: string | null;
    /**
     * The id the API stamped on this request. Support cannot find an auth
     * failure in the logs without it, and `describeError` reads it straight
     * off the error, so it has to be carried here the way `MikeApiError`
     * carries it.
     */
    requestId: string | null;

    constructor(
        status: number,
        code: string | null,
        message: string,
        requestId: string | null = null,
    ) {
        super(message);
        this.name = "AuthApiError";
        this.status = status;
        this.code = code;
        this.requestId = requestId;
    }
}

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `/api/auth${path}`;
    const method = init?.method ?? "GET";
    let response: Response;
    try {
        response = await fetch(url, {
            ...init,
            credentials: "include",
            cache: "no-store",
            headers: {
                ...(init?.body ? { "Content-Type": "application/json" } : {}),
                ...(init?.headers as Record<string, string> | undefined),
            },
        });
    } catch (error) {
        // Same rule as mikeApi: a request that never got a response is one
        // "API unreachable" event per outage, never one per auth screen.
        if (!init?.signal?.aborted && !isAbortError(error)) {
            reportNetworkFailure(error, { method, url });
        }
        throw error;
    }
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
            code?: unknown;
            detail?: unknown;
            request_id?: unknown;
        };
        const code = typeof body.code === "string" ? body.code : null;
        // Mirrors mikeApi.toApiError: the body wins, the header is the
        // fallback for a response that carried no JSON id.
        const requestId =
            typeof body.request_id === "string" && body.request_id
                ? body.request_id
                : response.headers.get("x-request-id");
        const error = new AuthApiError(
            response.status,
            code,
            typeof body.detail === "string"
                ? body.detail
                : "Authentication could not be completed.",
            requestId,
        );
        // A 4xx is the auth server's intentional answer (wrong password, a
        // spent link); a 5xx is a fault, reported under the same request id
        // the backend attached to its own event.
        if (response.status >= 500) {
            reportApiFailure({
                path: url,
                status: response.status,
                code,
                requestId,
                method,
                error,
            });
        }
        throw error;
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

export async function getAuthSession(): Promise<AuthUser | null> {
    try {
        return (await authRequest<{ user: AuthUser }>("/session")).user;
    } catch (error) {
        if (error instanceof AuthApiError && error.status === 401) return null;
        throw error;
    }
}

export async function login(email: string, password: string) {
    return authRequest<{ user: AuthUser }>("/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
    });
}

export async function signup(email: string, password: string, next: string) {
    return authRequest<{
        user: AuthUser;
        requiresEmailConfirmation: boolean;
    }>("/signup", {
        method: "POST",
        body: JSON.stringify({ email, password, next }),
    });
}

export async function startGoogleOAuth(next: string) {
    return authRequest<{ url: string }>("/oauth", {
        method: "POST",
        body: JSON.stringify({ provider: "google", next }),
    });
}

export function startSso(next: string, email: string) {
    return authRequest<{ url: string }>("/oauth", {
        method: "POST",
        body: JSON.stringify({ provider: "sso", next, email }),
    });
}

export async function exchangeAuthCode(code: string) {
    return authRequest<{ user: AuthUser }>("/exchange", {
        method: "POST",
        body: JSON.stringify({ code }),
    });
}

export async function requestPasswordReset(email: string) {
    return authRequest<void>("/password-reset", {
        method: "POST",
        body: JSON.stringify({ email }),
    });
}

export async function logout(scope: "local" | "global" = "local") {
    return authRequest<void>("/logout", {
        method: "POST",
        body: JSON.stringify({ scope }),
    });
}

export async function updateAuthEmail(email: string, next: string) {
    return authRequest<{ user: AuthUser }>("/email", {
        method: "PATCH",
        body: JSON.stringify({ email, next }),
    });
}

export async function updateAuthPassword(password: string, signOut = false) {
    return authRequest<{ user: AuthUser }>("/password", {
        method: "PATCH",
        body: JSON.stringify({ password, signOut }),
    });
}

export function listMfaFactors() {
    return authRequest<{ all: MfaFactor[]; totp: MfaFactor[] }>("/mfa/factors");
}

export function getMfaAssurance() {
    return authRequest<{
        currentLevel: string | null;
        nextLevel: string | null;
    }>("/mfa/assurance");
}

export function enrollMfa(friendlyName: string) {
    return authRequest<{
        id: string;
        totp: { qr_code: string; secret: string };
    }>("/mfa/enroll", {
        method: "POST",
        body: JSON.stringify({ friendlyName }),
    });
}

export function challengeMfa(factorId: string) {
    return authRequest<{ id: string }>("/mfa/challenge", {
        method: "POST",
        body: JSON.stringify({ factorId }),
    });
}

export function verifyMfa(factorId: string, challengeId: string, code: string) {
    return authRequest<unknown>("/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ factorId, challengeId, code }),
    });
}

export function challengeAndVerifyMfa(factorId: string, code: string) {
    return authRequest<unknown>("/mfa/challenge-and-verify", {
        method: "POST",
        body: JSON.stringify({ factorId, code }),
    });
}

export function unenrollMfa(factorId: string) {
    return authRequest<unknown>(
        `/mfa/factors/${encodeURIComponent(factorId)}`,
        {
            method: "DELETE",
        },
    );
}

export function clearLegacyBrowserAuthStorage() {
    if (typeof window === "undefined") return;
    for (const storage of [window.localStorage, window.sessionStorage]) {
        for (let index = storage.length - 1; index >= 0; index -= 1) {
            const key = storage.key(index);
            if (key && /(?:^|-)auth-token(?:$|-)|supabase.*auth/i.test(key)) {
                storage.removeItem(key);
            }
        }
    }
}
