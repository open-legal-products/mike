import express, { type NextFunction, type Request, type Response, Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute } from "../../middleware/asyncRoute";
import { verifyResearchPack } from "./researchPack.service";

export const researchPackRouter = Router();

export function configuredLoopbackOrigin(): string | null {
    const configured = process.env.API_PUBLIC_URL?.trim();
    if (!configured) return null;
    try {
        const url = new URL(configured);
        if (!["http:", "https:"].includes(url.protocol)) return null;
        if (!/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return null;
        if (!["", "/", "/api", "/api/"].includes(url.pathname)) return null;
        if (url.username || url.password || url.search || url.hash) return null;
        return url.origin;
    } catch {
        return null;
    }
}

function requireTrustedLoopback(req: Request, res: Response, next: NextFunction): void {
    const expectedOrigin = configuredLoopbackOrigin();
    if (!expectedOrigin) {
        res.status(404).json({ code: "research_pack_unavailable" });
        return;
    }
    const requestOrigin = req.get("origin");
    if (requestOrigin && requestOrigin !== expectedOrigin) {
        res.status(403).json({ code: "research_pack_loopback_only" });
        return;
    }
    next();
}

researchPackRouter.post(
    "/verify",
    requireAuth,
    requireTrustedLoopback,
    express.raw({ type: "application/octet-stream", limit: "4mb", inflate: false }),
    asyncRoute(async (req, res) => {
        if (!Buffer.isBuffer(req.body)) {
            res.status(415).json({ code: "research_pack_bytes_required" });
            return;
        }
        try {
            const report = await verifyResearchPack(req.body);
            res.status(report.integrity === "pass" ? 200 : 422).json(report);
        } catch (error) {
            const code = error instanceof Error
                ? error.message
                : "research_pack_verification_failed";
            const status = code === "research_pack_too_large"
                ? 413
                : code === "research_pack_busy"
                ? 429
                : 503;
            res.status(status).json({ code });
        }
    }),
);
