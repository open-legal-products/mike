"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FolderOpen, Plus } from "lucide-react";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ProjectPickerModal } from "@/app/components/modals/ProjectPickerModal";
import { NewProjectModal } from "@/app/components/projects/NewProjectModal";
import type { Project } from "@/app/components/shared/types";
import { useProjectPicker } from "@/app/hooks/useProjectPicker";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";

export default function IdePage() {
    const router = useRouter();
    const projectPicker = useProjectPicker();
    const [newProjectOpen, setNewProjectOpen] = useState(false);

    function openSelectedProject() {
        if (!projectPicker.selectedId) return;
        router.push(`/projects/${projectPicker.selectedId}/assistant/chat`);
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
                        projectPicker.error ??
                        "Open a Project to start drafting and reviewing with the help of the Project Assistant."
                    }
                    tone={projectPicker.error ? "error" : "default"}
                    action={
                        <div className="flex flex-wrap gap-2">
                            <PillButtonUI
                                tone="black"
                                size="sm"
                                onClick={() => void projectPicker.openPicker()}
                                loading={projectPicker.loading}
                            >
                                <FolderOpen className="h-3.5 w-3.5" />
                                Open project
                            </PillButtonUI>
                            <PillButtonUI
                                tone="white"
                                size="sm"
                                onClick={() => setNewProjectOpen(true)}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                New project
                            </PillButtonUI>
                        </div>
                    }
                />
            </div>

            <ProjectPickerModal
                open={projectPicker.open}
                onClose={projectPicker.closePicker}
                projects={projectPicker.projects ?? []}
                loading={projectPicker.loading}
                selectedId={projectPicker.selectedId}
                onSelect={projectPicker.setSelectedId}
                breadcrumbs={["IDE", "Open project"]}
                primaryAction={{
                    label: "Open project",
                    type: "button",
                    onClick: openSelectedProject,
                    disabled: !projectPicker.selectedId,
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
