"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FolderOpen, Plus } from "lucide-react";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import { ProjectPickerModal } from "@/app/components/modals/ProjectPickerModal";
import { NewProjectModal } from "@/app/components/projects/NewProjectModal";
import type { Project } from "@/app/components/shared/types";
import { listProjects } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";

export default function IdePage() {
    const router = useRouter();
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
        null,
    );
    const [projectPickerOpen, setProjectPickerOpen] = useState(false);
    const [newProjectOpen, setNewProjectOpen] = useState(false);
    const [projectsLoading, setProjectsLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    async function openProjectPicker() {
        setProjectPickerOpen(true);
        setLoadError(null);
        if (projects !== null || projectsLoading) return;

        setProjectsLoading(true);
        try {
            setProjects(await listProjects());
        } catch (error) {
            setProjectPickerOpen(false);
            setLoadError(
                userFacingApiError(
                    error,
                    "Projects could not be loaded. Please try again.",
                ),
            );
        } finally {
            setProjectsLoading(false);
        }
    }

    function openSelectedProject() {
        if (!selectedProjectId) return;
        router.push(`/projects/${selectedProjectId}/assistant/chat`);
    }

    function openCreatedProject(project: Project) {
        router.push(`/projects/${project.id}/assistant/chat`);
    }

    return (
        <div className="flex h-full min-h-0">
            <div
                className={cn(
                    "my-2 ml-2 mr-3 flex min-h-0 flex-1 items-center justify-center rounded-2xl px-8 pb-[76px] md:my-3",
                    LIQUID_GLASS_FLAT_CLASS,
                )}
            >
                <EmptyState
                    className="w-full max-w-md"
                    icon={
                        <Image
                            src="/icons/features/ide.svg"
                            alt=""
                            width={32}
                            height={32}
                            unoptimized
                        />
                    }
                    title="Integrated Drafting Environment"
                    description={
                        loadError ??
                        "Open a project to start drafting and reviewing with the help of the Project Assistant."
                    }
                    tone={loadError ? "error" : "default"}
                    action={
                        <div className="flex flex-wrap gap-2">
                            <PillButton
                                tone="black"
                                size="sm"
                                onClick={() => void openProjectPicker()}
                                loading={projectsLoading}
                            >
                                <FolderOpen className="h-3.5 w-3.5" />
                                Open project
                            </PillButton>
                            <PillButton
                                tone="white"
                                size="sm"
                                onClick={() => setNewProjectOpen(true)}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                New project
                            </PillButton>
                        </div>
                    }
                />
            </div>

            <ProjectPickerModal
                open={projectPickerOpen}
                onClose={() => setProjectPickerOpen(false)}
                projects={projects ?? []}
                loading={projectsLoading}
                selectedId={selectedProjectId}
                onSelect={setSelectedProjectId}
                breadcrumbs={["IDE", "Open project"]}
                primaryAction={{
                    label: "Open project",
                    type: "button",
                    onClick: openSelectedProject,
                    disabled: !selectedProjectId,
                }}
            />

            <NewProjectModal
                open={newProjectOpen}
                onClose={() => setNewProjectOpen(false)}
                onCreated={openCreatedProject}
            />
        </div>
    );
}
