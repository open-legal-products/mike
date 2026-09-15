// Business logic + data-access for the organizations / RBAC module.
//
// This is the module's single facade: the one door other modules, workers and
// jobs use to reach organization behaviour. The implementation lives in
// lib/orgs.ts rather than here because lib/access.ts and the org-aware access
// helpers depend on it, and lib/ may never import from modules/ — so the
// functions stay in lib and the module re-exports them by name.
//
// Everything below takes an explicit Supabase client (`db`) plus
// request-derived primitives, enforces the admin/member role model, and
// RETURNS a typed discriminated result. Nothing here touches req/res; the
// thin handlers in orgs.routes.ts map those results onto status codes, and
// lib/orgFailure.ts owns that mapping because the /user/invitations routes
// share it.

export {
  INVITATION_TTL_DAYS,
  listMyOrgs,
  createOrg,
  getOrg,
  updateOrg,
  deleteOrg,
  listOrgResources,
  listMembers,
  updateMember,
  removeMember,
  createInvitation,
  listInvitations,
  cancelInvitation,
  resendInvitation,
  listMyInvitations,
  acceptInvitation,
  declineInvitation,
} from "../../lib/orgs";

export type { InvitationStatus, OrgResult } from "../../lib/orgs";
