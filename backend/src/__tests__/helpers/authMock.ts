/**
 * Shared `middleware/auth` stub for the route integration suites.
 *
 * Route tests exercise handler logic, not token verification, so every suite
 * that mounts `../../app` replaced the auth middleware with the same pair of
 * pass-through handlers seeding a fixed user. That block was duplicated
 * verbatim across the integration suites; it lives here once instead.
 *
 * Usage — `vi.mock` factories are hoisted above imports, so pull the helper in
 * dynamically:
 *
 *     vi.mock("../../middleware/auth", async () => {
 *         const { authMock } = await import("../helpers/authMock");
 *         return authMock();
 *     });
 */

/** The user id/email every stubbed request authenticates as. */
export const TEST_USER_ID = "u1";
export const TEST_USER_EMAIL = "u1@test.local";

export function authMock() {
    return {
        requireAuth: (
            _req: unknown,
            res: { locals: Record<string, unknown> },
            next: () => void,
        ) => {
            res.locals.userId = TEST_USER_ID;
            res.locals.userEmail = TEST_USER_EMAIL;
            next();
        },
        requireMfaIfEnrolled: (
            _req: unknown,
            _res: unknown,
            next: () => void,
        ) => next(),
    };
}
