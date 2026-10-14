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
  listMyOrgs,
  createOrg,
  getOrg,
  updateOrg,
  listOrgResources,
  listMembers,
  updateMember,
  removeMember,
  getMemberHandover,
  type MemberHandover,
  createInvitation,
  listInvitations,
  cancelInvitation,
  resendInvitation,
} from "../../lib/orgs";

// The organization's provider keys live in this module: they need the user
// module's key store, which lib/ may not import.
export {
  getOrgApiKeySettings,
  saveOrgApiKey,
  setOrgApiKeyEnabled,
  setOrgPersonalApiKeysAllowed,
    saveOrgRouterModels,
    normalizeOrgRouterSlug,
  type OrgApiKeySettings,
} from "./orgs.apiKeys";

export {
    getOrgLogo,
    saveOrgLogo,
    removeOrgLogo,
} from "./orgs.logo";

// Deleting an organization, or one kind of its content, needs the documents
// and projects modules, so it lives here rather than in lib/orgs.ts.
export {
    deleteOrg,
    deleteOrgData,
    isOrgDataKind,
    type OrgDataKind,
} from "./orgs.deletion";

export { deleteOrgContent } from "./orgs.dataCleanup";
export {
    listDepartureArchives, listDepartures, resolveDepartureArchive, resolveDepartureArchives,
    expireDepartureArchives,
} from "./orgs.retention";

export { listDeletedOrganizations, restoreOrganization, purgeExpiredOrganizations } from "./orgs.lifecycle";
export { listPrivateContent, setPrivateContentPermission, changePrivateContentAccess } from "./orgs.privateContent";
