import { useWorkspace } from "@/app/contexts/WorkspaceContext";

/**
 * Whether the caller has more than one workspace: Personal and at least one
 * organization. Naming the workspace in view ("Delete all chats in Acme
 * LLP?") tells someone who has only Personal nothing, so such names show
 * only when this is true. False until the organizations have loaded, and
 * outside a WorkspaceProvider.
 */
export function useHasMultipleWorkspaces(): boolean {
    const { organizations } = useWorkspace();
    return (organizations?.length ?? 0) > 0;
}
