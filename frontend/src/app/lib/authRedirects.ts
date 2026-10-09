const AUTH_REDIRECT_PATHS = new Set([
    "/assistant",
    "/login",
    "/reset-password",
    "/settings",
    "/onboarding/profile",
    "/onboarding/practice",
]);

export function safeAuthNext(
    candidate: string | null | undefined,
    fallback = "/assistant",
): string {
    if (
        !candidate ||
        !candidate.startsWith("/") ||
        candidate.startsWith("//")
    ) {
        return fallback;
    }
    if (candidate.includes("\\") || /[\u0000-\u001f\u007f]/.test(candidate)) {
        return fallback;
    }

    const base = new URL("https://auth.mike.local");
    const resolved = new URL(candidate, base);
    if (
        resolved.origin !== base.origin ||
        !AUTH_REDIRECT_PATHS.has(resolved.pathname)
    ) {
        return fallback;
    }
    return `${resolved.pathname}${resolved.search}`;
}

export function authErrorDescription(
    search: string,
    hash: string,
): string | null {
    const query = new URLSearchParams(search);
    const fragment = new URLSearchParams(hash.replace(/^#/, ""));
    const error = (
        query.get("error_description") ||
        query.get("error") ||
        fragment.get("error_description") ||
        fragment.get("error")
    );
    if (!error) return null;
    if (/expired|invalid/i.test(error)) {
        return "This confirmation link is invalid or has expired.";
    }
    if (/access.denied|cancel/i.test(error)) {
        return "Authentication was cancelled or denied.";
    }
    return "Authentication could not be completed. Please try again.";
}
