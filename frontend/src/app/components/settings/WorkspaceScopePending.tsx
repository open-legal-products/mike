import { GlassCardUI, PillButtonUI } from "@mike/ui";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";

/**
 * Stands in for a Workspace settings page (Features, Model Preferences,
 * Bring Your Own Keys) while the active organization has not loaded, so it
 * is not yet known whether the caller may change them: a skeleton of one
 * settings card, or, once reading the organizations has failed, the reason
 * and a Retry.
 */
export function WorkspaceScopePending({
    unavailable,
}: {
    unavailable: boolean;
}) {
    const { refreshOrganizations } = useWorkspace();
    if (unavailable)
        return (
            <GlassCardUI>
                <SettingsRow>
                    <p className="text-sm text-red-600" role="alert">
                        Could not load this workspace&apos;s settings.
                    </p>
                    <PillButtonUI
                        type="button"
                        tone="white"
                        size="sm"
                        onClick={() => void refreshOrganizations()}
                    >
                        Retry
                    </PillButtonUI>
                </SettingsRow>
            </GlassCardUI>
        );
    return (
        <div
            className="space-y-3"
            aria-busy="true"
            data-testid="workspace-settings-loading"
        >
            <SkeletonLine className="h-4 w-32" />
            <GlassCardUI>
                {[0, 1].map((row) => (
                    <SettingsRow key={row}>
                        <div className="min-w-0 flex-1 space-y-2">
                            <SkeletonLine className="h-3.5 w-40" />
                            <SkeletonLine className="w-full max-w-sm" />
                        </div>
                        <SkeletonLine className="h-5 w-9 shrink-0 rounded-full" />
                    </SettingsRow>
                ))}
            </GlassCardUI>
        </div>
    );
}
