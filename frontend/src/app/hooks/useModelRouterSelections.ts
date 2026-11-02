import { useMemo } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    PERSONAL_WORKSPACE,
    useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import {
    ROUTER_SLUGS,
    routerSelections,
    type RouterSelections,
} from "@/shared/lib/modelCatalog";

/** The server's per-router lists as the pickers' `RouterSelections`. */
export function routerSelectionsFromLists(
    lists: Partial<Record<string, unknown>> | null | undefined,
): RouterSelections {
    return Object.fromEntries(
        ROUTER_SLUGS.map((slug) => {
            const models = lists?.[slug];
            return [
                slug,
                Array.isArray(models)
                    ? models.filter(
                          (model): model is string => typeof model === "string",
                      )
                    : [],
            ];
        }),
    ) as RouterSelections;
}

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
