import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import type { OrgPreferences, OrgPreferencesUpdate } from "@/app/lib/mikeApi";

/**
 * An organization's Features and Model Preferences for its settings pages,
 * which its owners and admins edit in Settings while in its workspace.
 *
 * Read afresh when a page opens, so an editor never starts from a stale
 * copy; until then (and if that read fails) the app-wide copy stands in.
 * Reads and saves go through WorkspaceContext, which keeps a read that
 * started before a save from replacing the saved answer, and puts a save's
 * answer in the app-wide copy so the assistant and the review dialogs follow
 * at once. `save` rejects with the server's error, for the page to report.
 */
export function useOrgPreferencesSettings(orgId: string): {
    preferences: OrgPreferences | null;
    loadError: boolean;
    retry: () => void;
    save: (update: OrgPreferencesUpdate) => Promise<OrgPreferences>;
} {
    const { orgPreferences, loadOrgPreferences, saveOrgPreferences } =
        useWorkspace();
    const [loadError, setLoadError] = useState(false);
    const [loadVersion, setLoadVersion] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        loadOrgPreferences(orgId, controller.signal)
            .then(() => {
                if (!controller.signal.aborted) setLoadError(false);
            })
            .catch(() => {
                if (!controller.signal.aborted) setLoadError(true);
            });
        return () => controller.abort();
    }, [loadVersion, orgId, loadOrgPreferences]);

    const retry = useCallback(() => {
        setLoadError(false);
        setLoadVersion((current) => current + 1);
    }, []);

    const save = useCallback(
        (update: OrgPreferencesUpdate) => saveOrgPreferences(orgId, update),
        [orgId, saveOrgPreferences],
    );

    return {
        preferences: orgPreferences,
        // A copy already in hand is still shown after a failed re-read.
        loadError: loadError && !orgPreferences,
        retry,
        save,
    };
}
