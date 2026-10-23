import { useMemo } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    PERSONAL_WORKSPACE,
    useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { apiKeyStateFromStatus } from "@/app/lib/apiKeyState";
import type { ApiKeyState } from "@/app/lib/mikeApi";

/**
 * The provider keys the model pickers judge availability against.
 *
 * Personal work runs on the caller's own keys. Work in an organization runs
 * on the organization's and the deployment's, never the caller's — so in an
 * organization workspace this is the server's answer for that organization,
 * not the profile's.
 *
 * `undefined` means "not known": the profile's keys failed to load, or the
 * organization's have not arrived. Callers fail open on it, as they always
 * have, because the server refuses a model it has no key for.
 */
export function useModelApiKeys(): ApiKeyState | undefined {
    const { profile, apiKeysDegraded } = useUserProfile();
    const { workspaceId, orgApiKeys } = useWorkspace();
    const inOrganization =
        workspaceId !== null && workspaceId !== PERSONAL_WORKSPACE;
    const personalKeys = apiKeysDegraded ? undefined : profile?.apiKeys;
    return useMemo(() => {
        if (!inOrganization) return personalKeys;
        return orgApiKeys
            ? apiKeyStateFromStatus(orgApiKeys.effective)
            : undefined;
    }, [inOrganization, orgApiKeys, personalKeys]);
}
