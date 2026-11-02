"use client";

import { useEffect, useState } from "react";
import type { Project } from "@/app/components/shared/types";
import { useWorkspaceParam } from "@/app/contexts/WorkspaceContext";
import { listProjects } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

type PickerState = {
    workspace: string | undefined;
    open: boolean;
    projects: Project[] | null;
    selectedId: string | null;
    error: string | null;
};

function emptyPicker(workspace: string | undefined, open = false): PickerState {
    return { workspace, open, projects: null, selectedId: null, error: null };
}

export function useProjectPicker() {
    const workspace = useWorkspaceParam();
    const [state, setState] = useState(() => emptyPicker(workspace));

    // Reset before rendering children so another workspace's rows and
    // selection cannot remain visible while the new request is pending.
    if (state.workspace !== workspace) {
        setState(emptyPicker(workspace, state.open));
    }

    const { open, projects } = state;
    useEffect(() => {
        if (!open || projects !== null) return;
        let cancelled = false;
        void listProjects({ participatingOnly: true, workspace }).then(
            (loaded) => {
                if (cancelled) return;
                setState((current) => ({ ...current, projects: loaded }));
            },
            (error: unknown) => {
                if (cancelled) return;
                setState((current) => ({
                    ...current,
                    open: false,
                    error: userFacingApiError(
                        error,
                        "Projects could not be loaded. Please try again.",
                    ),
                }));
            },
        );
        return () => {
            cancelled = true;
        };
    }, [open, projects, workspace]);

    return {
        open,
        projects,
        selectedId: state.selectedId,
        setSelectedId: (selectedId: string | null) =>
            setState((current) => ({ ...current, selectedId })),
        loading: open && projects === null,
        error: state.error,
        openPicker: () => setState((current) => ({ ...current, open: true, error: null })),
        closePicker: () => setState((current) => ({ ...current, open: false })),
        clearError: () => setState((current) => ({ ...current, error: null })),
    };
}
