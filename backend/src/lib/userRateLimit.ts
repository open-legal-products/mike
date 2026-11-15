import rateLimit from "express-rate-limit";
import { rateLimitedBody } from "./httpError";
import { envInt } from "./runtimeConfig";

/**
 * A rate limiter keyed by the signed-in user rather than the IP address.
 * Mount it after requireAuth, which sets res.locals.userId.
 *
 * The per-IP limiters in app.ts are the wrong unit for endpoints that
 * answer questions about other people: one account can spend the whole IP
 * budget, and everyone behind a firm's single NAT address shares it.
 */
export function userRateLimiter(options: {
    maxEnv: string;
    defaultMax: number;
    windowMinutesEnv: string;
    defaultWindowMinutes: number;
    message: string;
}) {
    return rateLimit({
        windowMs:
            envInt(options.windowMinutesEnv, options.defaultWindowMinutes) *
            60 * 1000,
        max: envInt(options.maxEnv, options.defaultMax),
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (_req, res) => String(res.locals.userId),
        message: rateLimitedBody(options.message),
    });
}

/**
 * One budget shared by every direct-share write: project, chat and tabular
 * review access, workflow shares and playbook shares. Each of them tells the
 * caller whether an address has an account, so one shared budget per user
 * bounds that signal however the attempts are spread across them.
 *
 * 120 an hour by default: the share dialogs send one request per recipient
 * (or role change), so sharing a matter with a 50-person team, and fixing a
 * few roles afterwards, stays well inside it.
 */
export const directShareLimiter = userRateLimiter({
    maxEnv: "RATE_LIMIT_DIRECT_SHARE_MAX",
    defaultMax: 120,
    windowMinutesEnv: "RATE_LIMIT_DIRECT_SHARE_WINDOW_MINUTES",
    defaultWindowMinutes: 60,
    message: "Too many sharing requests. Please try again later.",
});
