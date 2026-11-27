import {
  routerSelectionsFromLists,
  workspaceOrgId,
  type RouterSelections,
} from "@mike/client";
import {
  getApiKeyStatus,
  getOrgApiKeys,
  type ApiKeyStatus,
} from "../api/mikeApi";

/**
 * The provider keys and router lists the composer judges models against, for
 * the workspace the pane is in.
 *
 * Personal work runs on the caller's own keys, with the router lists saved on
 * their profile. Work in an organization runs on the organization's keys and
 * lists, as the server decides them for that chat, so the pane reads the
 * organization's effective settings there, as the web app's pickers do.
 */
interface WorkspaceModelAccess {
  /** The organization, or null in Personal. */
  orgId: string | null;
  keyStatus: ApiKeyStatus;
  /**
   * The organization's effective router lists; null in Personal, where they
   * come from the caller's profile.
   */
  routerSelections: RouterSelections | null;
  /** Whether the caller may change the organization's keys; false in Personal. */
  canManage: boolean;
}

export async function loadWorkspaceModelAccess(
  workspaceId: string,
): Promise<WorkspaceModelAccess> {
  const orgId = workspaceOrgId(workspaceId) ?? null;
  if (!orgId) {
    return {
      orgId: null,
      keyStatus: await getApiKeyStatus(),
      routerSelections: null,
      canManage: false,
    };
  }
  const settings = await getOrgApiKeys(orgId);
  return {
    orgId,
    keyStatus: settings.effective,
    routerSelections: routerSelectionsFromLists(
      settings.effective_router_models,
    ),
    canManage: settings.can_manage === true,
  };
}
