import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { resumeBrief, designateBrief, proposeBrief, getBriefProposal, applyBrief, readBriefSource } from "./projectBrief.service";
export const projectBriefRouter = Router({ mergeParams: true });
projectBriefRouter.use(requireAuth);
projectBriefRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
projectBriefRouter.use((req, res, next) => { if (!z.string().uuid().safeParse(req.params.projectId).success) {
    res.status(400).json({ detail: "Invalid project." });
    return;
} next(); });
projectBriefRouter.get("/", asyncRoute(async (req, res) => {
    const r = await resumeBrief(createServerSupabase(), { projectId: req.params.projectId, userId: res.locals.userId, userEmail: res.locals.userEmail });
    if (!r.ok)
        return void sendServiceFailure(res, r);
    res.json(r.data);
}));
projectBriefRouter.post("/designate", asyncRoute(async (req, res) => {
    const body = z.object({ documentId: z.string().uuid(), confirmShared: z.literal(true) }).strict().safeParse(req.body);
    if (!body.success)
        return void res.status(400).json({ detail: "Select a DOCX and confirm project sharing." });
    const r = await designateBrief(createServerSupabase(), { projectId: req.params.projectId, userId: res.locals.userId, userEmail: res.locals.userEmail }, body.data.documentId);
    if (!r.ok)
        return void sendServiceFailure(res, r);
    res.json(r.data);
}));
projectBriefRouter.post("/proposals", asyncRoute(async (req, res) => {
    const body = z.object({ sourceIds: z.array(z.string().uuid()).min(1).max(10), model: z.string().trim().min(1).max(150), confirmProvider: z.literal(true) }).strict().safeParse(req.body);
    if (!body.success)
        return void res.status(400).json({ detail: "Select sources, a model and confirm transmission to the configured provider." });
    const r = await proposeBrief(createServerSupabase(), { projectId: req.params.projectId, userId: res.locals.userId, userEmail: res.locals.userEmail }, body.data);
    if (!r.ok)
        return void sendServiceFailure(res, r);
    res.status(201).json(r.data);
}));
projectBriefRouter.get("/proposals/:proposalId", asyncRoute(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.proposalId).success)
        return void res.status(400).json({ detail: "Invalid proposal." });
    const r = await getBriefProposal(createServerSupabase(), { projectId: req.params.projectId, userId: res.locals.userId, userEmail: res.locals.userEmail }, req.params.proposalId);
    if (!r.ok)
        return void sendServiceFailure(res, r);
    res.json(r.data);
}));
projectBriefRouter.post("/proposals/:proposalId/apply", asyncRoute(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.proposalId).success || !z.object({ confirmReviewed: z.literal(true), confirmShared: z.literal(true) }).strict().safeParse(req.body).success)
        return void res.status(400).json({ detail: "Confirm review and project sharing before Apply." });
    const r = await applyBrief(createServerSupabase(), { projectId: req.params.projectId, userId: res.locals.userId, userEmail: res.locals.userEmail }, req.params.proposalId);
    if (!r.ok)
        return void sendServiceFailure(res, r);
    res.json(r.data);
}));
projectBriefRouter.get("/sources/:documentId/:versionId", asyncRoute(async (req, res) => {
    const input = z.object({ documentId: z.string().uuid(), versionId: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().uuid() }).safeParse({ documentId: req.params.documentId, versionId: req.params.versionId, hash: req.query.hash, revision: req.query.revision });
    if (!input.success)
        return void res.status(400).json({ detail: "Invalid source identity." });
    const r = await readBriefSource(createServerSupabase(), { projectId: req.params.projectId, userId: res.locals.userId, userEmail: res.locals.userEmail }, input.data);
    if (!r.ok)
        return void sendServiceFailure(res, r);
    res.setHeader("Content-Type", r.data.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${r.data.filename}"`);
    res.send(Buffer.from(r.data.bytes));
}));
projectBriefRouter.use(routerErrorHandler("[project-brief]"));
