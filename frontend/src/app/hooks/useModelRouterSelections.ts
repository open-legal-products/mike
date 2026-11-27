import { useMemo } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    PERSONAL_WORKSPACE,
    useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import {
    routerSelections,
    routerSelectionsFromLists,
    type RouterSelections,
} from "@mike/client";

export { routerSelectionsFromLists } from "@mike/client";

/**
 * The saved Model Selections the pickers offer for the "model list"
 * providers (OpenRouter, Bedrock, Azure and the like).
 *
 * Personal work offers the caller's own. In an organization workspace a
 * provider whose key the organization holds offers the organization's list
 * instead — the server's answer, which is also what a request is checked
 * against (see useModelApiKeys for the matching keys).
 *
 * `undefined` means "not known yet": the profile or the organization's
 * settings have not loaded. Callers leave a stored selection alone on it.
 */
export function useModelRouterSelections(): RouterSelections | undefined {
    const { profile } = useUserProfile();
    const { workspaceId, orgApiKeys } = useWorkspace();
    const inOrganization =
        workspaceId !== null && workspaceId !== PERSONAL_WORKSPACE;
    return useMemo(() => {
        if (inOrganization)
            return orgApiKeys
                ? routerSelectionsFromLists(orgApiKeys.effective_router_models)
                : undefined;
        return profile ? routerSelections(profile) : undefined;
    }, [inOrganization, orgApiKeys, profile]);
}
