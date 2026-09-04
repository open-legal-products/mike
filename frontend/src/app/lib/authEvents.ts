export const AUTH_SESSION_INVALIDATED_EVENT = "mike:auth-session-invalidated";

/**
 * Fetch an authenticated application resource and immediately invalidate the
 * browser's in-memory auth state when the backend rejects the session.
 */
export async function authenticatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const response = await globalThis.fetch(input, {
        ...init,
        credentials: "include",
    });

    if (response.status === 401 && typeof window !== "undefined") {
        let invalidSession = true;
        try {
            const body = (await response.clone().json()) as { code?: unknown };
            invalidSession = body.code !== "oauth_required";
        } catch {
            // A non-JSON 401 is still an authentication failure.
        }
        if (invalidSession) {
            window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
        }
    }

    return response;
}
