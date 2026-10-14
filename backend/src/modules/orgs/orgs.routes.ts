// Express router for organizations + RBAC, mounted at /orgs.
//
// Thin handlers: they read res.locals (userId/userEmail set by requireAuth),
// delegate to orgs.service.ts, and map the discriminated results onto HTTP
// status codes with {detail} bodies — mirroring modules/projects.
//
// Note what is NOT here: there is no "add a member" endpoint. Membership is
// created by accepting an invitation (POST /orgs/:orgId/invitations here,
// POST /user/invitations/:id/accept in modules/user/user.routes.ts), so an
// admin can never pull somebody into a workspace full of confidential
// material without them agreeing to it.

import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendOrgFailure } from "../../lib/orgFailure";
import { isPersonalOrg } from "../../lib/personalOrgs";
import { parsePaginationQuery } from "../../lib/pagination";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
    listPrivateContent,
    setPrivateContentPermission,
    changePrivateContentAccess,
    listDeletedOrganizations,
    restoreOrganization,
    listMyOrgs,
    createOrg,
    getOrg,
    updateOrg,
    deleteOrg,
    deleteOrgData,
    isOrgDataKind,
    listOrgResources,
    listMembers,
    updateMember,
    removeMember,
    getMemberHandover,
    createInvitation,
    listInvitations,
    cancelInvitation,
    resendInvitation,
    getOrgApiKeySettings,
    saveOrgApiKey,
    setOrgApiKeyEnabled,
    setOrgPersonalApiKeysAllowed,
    getOrgLogo,
    saveOrgLogo,
    removeOrgLogo,
    saveOrgRouterModels,
    normalizeOrgRouterSlug,
    listDepartureArchives,
    listDepartures,
    resolveDepartureArchive,
    resolveDepartureArchives,
} from "./orgs.service";
import { normalizeApiKeyProvider } from "../user/user.service";

export const orgsRouter = Router();

// A person's own organization is behind the scenes: it has no settings,
// roster, invitations, keys or logo to reach, and it is neither renamed nor
// deleted. Every route that names an organization answers for it exactly as
// it does for one that is not there.
function refusePersonalOrg(req: Request, res: Response, next: NextFunction) {
    isPersonalOrg(createServerSupabase(), String(req.params.orgId)).then(
        (personal) => {
            if (personal)
                return sendOrgFailure(res, { ok: false, kind: "not_found" });
            next();
        },
        next,
    );
}
const requireOrgAuth = [requireAuth, refusePersonalOrg];

orgsRouter.get("/:orgId/private-content", requireOrgAuth, asyncRoute(async (req, res) => {
    const result = await listPrivateContent(createServerSupabase(), {
        orgId: req.params.orgId, userId: res.locals.userId,
        ...parsePaginationQuery(req.query), search: req.query.search,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.json(result.data);
}));

orgsRouter.put("/:orgId/members/:userId/private-content-permission", requireOrgAuth, asyncRoute(async (req, res) => {
    const result = await setPrivateContentPermission(createServerSupabase(), {
        orgId: req.params.orgId, userId: res.locals.userId,
        targetUserId: req.params.userId, enabled: req.body?.enabled,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.status(204).send();
}));

orgsRouter.post("/:orgId/private-content/:kind/:itemId/open", requireOrgAuth, asyncRoute(async (req, res) => {
    const result = await changePrivateContentAccess(createServerSupabase(), {
        orgId: req.params.orgId, userId: res.locals.userId,
        kind: req.params.kind, itemId: req.params.itemId, open: true,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.status(204).send();
}));

orgsRouter.delete("/:orgId/private-content/:kind/:itemId", requireOrgAuth, asyncRoute(async (req, res) => {
    const result = await changePrivateContentAccess(createServerSupabase(), {
        orgId: req.params.orgId, userId: res.locals.userId,
        kind: req.params.kind, itemId: req.params.itemId, open: false,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.status(204).send();
}));

orgsRouter.get("/deleted", requireAuth, asyncRoute(async (_req, res) => {
    const result = await listDeletedOrganizations(createServerSupabase(), res.locals.userId);
    if (!result.ok) return sendServiceFailure(res, result);
    res.json(result.data);
}));

orgsRouter.post("/:orgId/restore", requireOrgAuth, requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const result = await restoreOrganization(createServerSupabase(), req.params.orgId, res.locals.userId);
    if (!result.ok) return sendServiceFailure(res, result);
    res.status(204).send();
}));

orgsRouter.get("/:orgId/archives", requireOrgAuth, asyncRoute(async (req, res) => {
    const result = await listDepartureArchives(createServerSupabase(), {
        orgId: req.params.orgId, userId: res.locals.userId,
        ...parsePaginationQuery(req.query),
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.json(result.data);
}));

// The archive grouped by departed member, for the Departed members view.
orgsRouter.get("/:orgId/departures", requireOrgAuth, asyncRoute(async (req, res) => {
    const result = await listDepartures(createServerSupabase(), {
        orgId: req.params.orgId, userId: res.locals.userId,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.json(result.data);
}));

// Several archived items at once: one member's whole departure, or a selection.
orgsRouter.post("/:orgId/archives/recover", requireOrgAuth, asyncRoute(async (req, res) => {
    const result = await resolveDepartureArchives(createServerSupabase(), {
        orgId: req.params.orgId, userId: res.locals.userId,
        archiveIds: req.body?.archive_ids, successorId: req.body?.assign_to, delete: false,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.json(result.data);
}));

orgsRouter.post("/:orgId/archives/delete", requireOrgAuth, requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const result = await resolveDepartureArchives(createServerSupabase(), {
        orgId: req.params.orgId, userId: res.locals.userId,
        archiveIds: req.body?.archive_ids, delete: true,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.json(result.data);
}));

orgsRouter.post("/:orgId/archives/:archiveId/recover", requireOrgAuth, asyncRoute(async (req, res) => {
    const result = await resolveDepartureArchive(createServerSupabase(), {
        orgId: req.params.orgId, archiveId: req.params.archiveId,
        userId: res.locals.userId, successorId: req.body?.assign_to, delete: false,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.status(204).send();
}));

orgsRouter.delete("/:orgId/archives/:archiveId", requireOrgAuth, requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const result = await resolveDepartureArchive(createServerSupabase(), {
        orgId: req.params.orgId, archiveId: req.params.archiveId,
        userId: res.locals.userId, delete: true,
    });
    if (!result.ok) return sendServiceFailure(res, result);
    res.status(204).send();
}));

// GET /orgs — orgs the caller belongs to (with their role + member count).
orgsRouter.get("/", requireAuth, asyncRoute(async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listMyOrgs(db, userId);
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.orgs);
}));

// POST /orgs — create an org; the caller becomes its first admin.
orgsRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await createOrg(db, { userId, userEmail: res.locals.userEmail, name: req.body?.name });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(201).json(result.org);
}));

// GET /orgs/:orgId — org detail (any member).
orgsRouter.get("/:orgId", requireOrgAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await getOrg(db, { userId, orgId: req.params.orgId });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.org);
}));

// PATCH /orgs/:orgId — rename the org (admin only).
orgsRouter.patch("/:orgId", requireOrgAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await updateOrg(db, {
        userId,
        orgId: req.params.orgId,
        name: req.body?.name,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.org);
}));

// GET /orgs/:orgId/logo — the organization's logo, as a data URL (any
// member). 404 when it has none.
orgsRouter.get("/:orgId/logo", requireOrgAuth, asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const result = await getOrgLogo(db, {
        userId: res.locals.userId as string,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.logo);
}));

// PUT /orgs/:orgId/logo — set or replace the logo (owner or admin). The body
// carries the image as a PNG, JPEG or WebP data URL.
orgsRouter.put("/:orgId/logo", requireOrgAuth, asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const result = await saveOrgLogo(db, {
        actorId: res.locals.userId as string,
        actorEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
        dataUrl: req.body?.data_url,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json({ logo_updated_at: result.logo_updated_at });
}));

// DELETE /orgs/:orgId/logo — remove the logo (owner or admin).
orgsRouter.delete("/:orgId/logo", requireOrgAuth, asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const result = await removeOrgLogo(db, {
        actorId: res.locals.userId as string,
        actorEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json({ logo_updated_at: result.logo_updated_at });
}));

// DELETE /orgs/:orgId/data/:kind — permanently delete one kind of content
// across the organization (owner only): chats, tabular-reviews, projects or
// memories. The organization-level twin of the DELETE /user/* routes.
orgsRouter.delete(
    "/:orgId/data/:kind",
    requireOrgAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const kind = req.params.kind;
        if (!isOrgDataKind(kind))
            return void res.status(404).json({ detail: "Not found" });
        const db = createServerSupabase();
        const result = await deleteOrgData(db, {
            userId: res.locals.userId as string,
            userEmail: res.locals.userEmail as string | undefined,
            orgId: req.params.orgId,
            kind,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.status(204).send();
    }),
);

// DELETE /orgs/:orgId — delete an org and everything it owns (owner only).
// Organization-owned resources are destroyed with it; they never become
// anyone's personal data as a side effect.
orgsRouter.delete("/:orgId", requireOrgAuth, requireMfaIfEnrolled, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await deleteOrg(db, {
        userId,
        userEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(204).send();
}));

// GET /orgs/:orgId/resources — every organization-scoped project and workflow.
// Chats and tabular reviews only inherit organization access from projects and
// are browsed inside those projects rather than as independent org resources.
orgsRouter.get("/:orgId/resources", requireOrgAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listOrgResources(db, {
        userId,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json({
        projects: result.projects,
        workflows: result.workflows,
    });
}));

// GET /orgs/:orgId/members — the accepted roster (any member).
orgsRouter.get("/:orgId/members", requireOrgAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listMembers(db, { userId, orgId: req.params.orgId });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.members);
}));

// PATCH /orgs/:orgId/members/:userId — change a member's role (admin only).
orgsRouter.patch("/:orgId/members/:userId", requireOrgAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await updateMember(db, {
        actorId: userId,
        actorEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
        targetUserId: req.params.userId,
        role: req.body?.role,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.member);
}));

// DELETE /orgs/:orgId/members/:userId — remove a member (admin, or self).
orgsRouter.delete("/:orgId/members/:userId", requireOrgAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await removeMember(db, {
        actorId: userId,
        actorEmail: res.locals.userEmail as string | undefined,
        orgId: req.params.orgId,
        targetUserId: req.params.userId,
        // In the query string: not every proxy forwards a DELETE's body.
        assignTo: req.query.assign_to ?? req.body?.assign_to,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(204).send();
}));

// GET /orgs/:orgId/members/:userId/handover — what removing this member (or
// leaving, for the caller's own id) would hand over and delete. Asked before
// the removal, by the dialog that names a successor.
orgsRouter.get("/:orgId/members/:userId/handover", requireOrgAuth, asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const result = await getMemberHandover(db, {
        actorId: res.locals.userId as string,
        orgId: req.params.orgId,
        targetUserId: req.params.userId,
        departingUserIds: req.query.departing_user_ids === undefined
            ? undefined
            : typeof req.query.departing_user_ids === "string"
              ? req.query.departing_user_ids.split(",")
              : req.query.departing_user_ids,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.handover);
}));

// ---------------------------------------------------------------------------
// Invitations (admin side)
// ---------------------------------------------------------------------------

// POST /orgs/:orgId/invitations — invite an email at a role (admin only).
orgsRouter.post("/:orgId/invitations", requireOrgAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await createInvitation(db, {
        actorId: userId,
        actorEmail: userEmail,
        orgId: req.params.orgId,
        email: req.body?.email,
        role: req.body?.role,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.status(201).json(result.invitation);
}));

// GET /orgs/:orgId/invitations — pending/recent invitations (admin only).
orgsRouter.get("/:orgId/invitations", requireOrgAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await listInvitations(db, {
        userId,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.invitations);
}));

// DELETE /orgs/:orgId/invitations/:invitationId — cancel (admin only).
orgsRouter.delete(
    "/:orgId/invitations/:invitationId",
    requireOrgAuth,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await cancelInvitation(db, {
            actorId: userId,
            actorEmail: userEmail,
            orgId: req.params.orgId,
            invitationId: req.params.invitationId,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.status(204).send();
    }),
);

// POST /orgs/:orgId/invitations/:invitationId/resend — refresh expiry.
//
// The repository has no outbound email infrastructure, so "resend" moves the
// expiry window rather than re-delivering a message; the invitation surfaces
// in-app through GET /user/invitations either way. Wiring a mailer in would
// mean adding a dependency this PR deliberately does not take on.
orgsRouter.post(
    "/:orgId/invitations/:invitationId/resend",
    requireOrgAuth,
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        const result = await resendInvitation(db, {
            actorId: userId,
            actorEmail: userEmail,
            orgId: req.params.orgId,
            invitationId: req.params.invitationId,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.invitation);
    }),
);

// ---------------------------------------------------------------------------
// Provider keys and the personal-key setting
// ---------------------------------------------------------------------------
//
// Writes carry requireMfaIfEnrolled, as the personal key routes do: saving a
// key decides where the organization's work is sent.

// GET /orgs/:orgId/api-keys — which providers are set up (any member).
// Reports configuration only; a saved key is never sent back.
orgsRouter.get("/:orgId/api-keys", requireOrgAuth, asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const result = await getOrgApiKeySettings(db, {
        userId: res.locals.userId as string,
        orgId: req.params.orgId,
    });
    if (!result.ok) return sendOrgFailure(res, result);
    res.json(result.settings);
}));

// PUT /orgs/:orgId/api-keys/policy — whether members' own keys may be used
// for a provider the organization has no key for (owner or admin).
// Declared before /:provider so "policy" is never read as a provider name.
orgsRouter.put(
    "/:orgId/api-keys/policy",
    requireOrgAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const db = createServerSupabase();
        const result = await setOrgPersonalApiKeysAllowed(db, {
            actorId: res.locals.userId as string,
            actorEmail: res.locals.userEmail as string | undefined,
            orgId: req.params.orgId,
            allowed: req.body?.allow_personal_api_keys,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.settings);
    }),
);

// PUT /orgs/:orgId/api-keys/:provider/models — the models the organization's
// key for a "model list" provider may run (owner or admin). The whole list
// is replaced; an empty one removes them all.
orgsRouter.put(
    "/:orgId/api-keys/:provider/models",
    requireOrgAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const provider = normalizeOrgRouterSlug(req.params.provider);
        if (!provider)
            return void res.status(400).json({
                detail: "This provider does not keep a model list.",
            });
        const db = createServerSupabase();
        const result = await saveOrgRouterModels(db, {
            actorId: res.locals.userId as string,
            actorEmail: res.locals.userEmail as string | undefined,
            orgId: req.params.orgId,
            provider,
            modelIds: req.body?.model_ids,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.settings);
    }),
);

// PUT /orgs/:orgId/api-keys/:provider — save, replace or (with no key and
// no settings) remove the organization's key (owner or admin).
orgsRouter.put(
    "/:orgId/api-keys/:provider",
    requireOrgAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider)
            return void res.status(400).json({ detail: "Unsupported provider" });
        const db = createServerSupabase();
        const result = await saveOrgApiKey(db, {
            actorId: res.locals.userId as string,
            actorEmail: res.locals.userEmail as string | undefined,
            orgId: req.params.orgId,
            provider,
            apiKey:
                typeof req.body?.api_key === "string" ? req.body.api_key : null,
            settings:
                req.body && typeof req.body === "object"
                    ? (req.body as { settings?: unknown }).settings
                    : undefined,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.settings);
    }),
);

// PATCH /orgs/:orgId/api-keys/:provider — keep the key, turn the provider
// off or on for the organization (owner or admin).
orgsRouter.patch(
    "/:orgId/api-keys/:provider",
    requireOrgAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider || typeof req.body?.enabled !== "boolean")
            return void res.status(400).json({
                detail: "A supported provider and boolean enabled value are required.",
            });
        const db = createServerSupabase();
        const result = await setOrgApiKeyEnabled(db, {
            actorId: res.locals.userId as string,
            actorEmail: res.locals.userEmail as string | undefined,
            orgId: req.params.orgId,
            provider,
            enabled: req.body.enabled,
        });
        if (!result.ok) return sendOrgFailure(res, result);
        res.json(result.settings);
    }),
);

orgsRouter.use(routerErrorHandler("[orgs]"));
