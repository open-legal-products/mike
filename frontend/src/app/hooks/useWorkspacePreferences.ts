import { useMemo } from "react";
import { useOptionalUserProfile } from "@/app/contexts/UserProfileContext";
import {
    PERSONAL_WORKSPACE,
    useWorkspace,
} from "@/app/contexts/WorkspaceContext";

/**
 * The Features and Model Preferences that govern work in the active
 * workspace, for the screens that act on them.
 *
 * Personal work follows the caller's own settings. An organization governs
 * work in its workspace: there these are its settings, never the caller's.
 * Each value is `undefined` while it is not known (the profile or the
 * organization's settings have not loaded), and callers apply their default.
 */
export interface WorkspacePreferences {
    quickActionsVisible: boolean | undefined;
    responseDetailsVisible: boolean | undefined;
    /** The model preselected for a new tabular review; `null` for none. */
    tabularModel: string | null | undefined;
}

export function useWorkspacePreferences(): WorkspacePreferences {
    // Optional: a response can be drawn outside the profile provider.
    const profile = useOptionalUserProfile()?.profile ?? null;
    const { workspaceId, orgPreferences } = useWorkspace();
    const inOrganization =
        workspaceId !== null && workspaceId !== PERSONAL_WORKSPACE;
    return useMemo(() => {
        if (inOrganization)
            return {
                quickActionsVisible: orgPreferences?.quick_actions_visible,
                responseDetailsVisible:
                    orgPreferences?.response_details_visible,
                tabularModel: orgPreferences
                    ? orgPreferences.tabular_model
                    : undefined,
            };
        return {
            quickActionsVisible: profile?.quickActionsVisible,
            responseDetailsVisible: profile?.responseDetailsVisible,
            tabularModel: profile ? profile.tabularModel : undefined,
        };
    }, [inOrganization, orgPreferences, profile]);
}
