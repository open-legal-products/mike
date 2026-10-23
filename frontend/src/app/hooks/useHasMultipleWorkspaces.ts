import { useWorkspace } from "@/app/contexts/WorkspaceContext";

/**
 * Whether the caller has more than one workspace: Personal and at least one
 * organization. A note that something belongs to the workspace in view
 * ("Deletes data in Acme LLP only", "Each workspace has its own …") tells
 * someone who has only Personal nothing, so such notes show only when this
 * is true. False until the organizations have loaded, and outside a
 * WorkspaceProvider.
 */
export function useHasMultipleWorkspaces(): boolean {
    const { organizations } = useWorkspace();
    return (organizations?.length ?? 0) > 0;
}
