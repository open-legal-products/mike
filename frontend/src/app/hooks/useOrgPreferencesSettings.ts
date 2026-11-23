import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
    getOrgPreferences,
    updateOrgPreferences,
    type OrgPreferences,
    type OrgPreferencesUpdate,
} from "@/app/lib/mikeApi";

/**
 * An organization's Features and Model Preferences for its settings pages,
 * which its owners and admins edit in Settings while in its workspace.
 *
 * Read afresh when a page opens, so an editor never starts from a stale
 * copy; until then (and if that read fails) the app-wide copy stands in.
 * A save puts the answer in the app-wide copy (WorkspaceContext), so the
 * assistant and the review dialogs follow at once. `save` rejects with the
 * server's error, for the page to report.
 */
export function useOrgPreferencesSettings(orgId: string): {
    preferences: OrgPreferences | null;
    loadError: boolean;
    retry: () => void;
    save: (update: OrgPreferencesUpdate) => Promise<OrgPreferences>;
} {
    const { orgPreferences, setOrgPreferences } = useWorkspace();
    const [loadError, setLoadError] = useState(false);
    const [loadVersion, setLoadVersion] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        getOrgPreferences(orgId, controller.signal)
            .then((loaded) => {
                if (controller.signal.aborted) return;
                setOrgPreferences(orgId, loaded);
                setLoadError(false);
            })
            .catch(() => {
                if (!controller.signal.aborted) setLoadError(true);
            });
        return () => controller.abort();
    }, [loadVersion, orgId, setOrgPreferences]);

    const retry = useCallback(() => {
        setLoadError(false);
        setLoadVersion((current) => current + 1);
    }, []);

    const save = useCallback(
        async (update: OrgPreferencesUpdate) => {
            const saved = await updateOrgPreferences(orgId, update);
            setOrgPreferences(orgId, saved);
            return saved;
        },
        [orgId, setOrgPreferences],
    );

    return {
        preferences: orgPreferences,
        // A copy already in hand is still shown after a failed re-read.
        loadError: loadError && !orgPreferences,
        retry,
        save,
    };
}
