"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "../modals/Modal";
import { ModalSelect } from "../modals/ModalSelect";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import type { Project, TabularReview } from "../shared/types";

interface TabularReviewDetailsModalProps {
    open: boolean;
    review: TabularReview | null;
    projects: Project[];
    canEdit: boolean;
    lockProject?: boolean;
    onClose: () => void;
    onSave: (values: {
        title: string;
        projectId?: string | null;
    }) => Promise<void>;
}

export function TabularReviewDetailsModal({
    open,
    review,
    projects,
    canEdit,
    lockProject = false,
    onClose,
    onSave,
}: TabularReviewDetailsModalProps) {
    const [titleDraft, setTitleDraft] = useState("");
    const [underProject, setUnderProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open || !review) return;
        setTitleDraft(review.title ?? "");
        setUnderProject(Boolean(review.project_id));
        setSelectedProjectId(review.project_id ?? "");
        setSaving(false);
        setSaved(false);
        setError(null);
    }, [open, review]);

    const trimmedTitle = titleDraft.trim();
    const nextProjectId = underProject ? selectedProjectId : null;
    const projectOptions = useMemo(
        () =>
            projects.length
                ? projects.map((project) => ({
                      value: project.id,
                      label:
                          project.name +
                          (project.cm_number ? ` (#${project.cm_number})` : ""),
                  }))
                : [{ value: "", label: "No projects found" }],
        [projects],
    );
    const hasChanges = useMemo(() => {
        if (!review) return false;
        return (
            trimmedTitle !== (review.title ?? "") ||
            nextProjectId !== (review.project_id ?? null)
        );
    }, [nextProjectId, review, trimmedTitle]);

    if (!review) return null;

    async function handleSave() {
        if (
            !canEdit ||
            saving ||
            !hasChanges ||
            !trimmedTitle ||
            (underProject && !selectedProjectId)
        ) {
            return;
        }
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            await onSave({
                title: trimmedTitle,
                projectId: nextProjectId,
            });
            setSaved(true);
        } catch {
            setError("Could not update tabular review details.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[
                "Tabular Reviews",
                review.title || "Untitled Review",
                "Details",
            ]}
            footerStatus={
                error ? (
                    <span className="text-sm text-red-600">{error}</span>
                ) : saved ? (
                    <span className="text-sm text-gray-400">Updated</span>
                ) : null
            }
            primaryAction={
                canEdit
                    ? {
                          label: saving ? "Saving..." : "Save",
                          onClick: () => void handleSave(),
                          disabled:
                              saving ||
                              !hasChanges ||
                              !trimmedTitle ||
                              (underProject && !selectedProjectId),
                      }
                    : undefined
            }
            cancelAction={canEdit ? undefined : false}
        >
            <div className="space-y-6">
                <div>
                    <FieldLabel htmlFor="tabular-review-details-title">
                        Review name
                    </FieldLabel>
                    <FormTextInput
                        id="tabular-review-details-title"
                        type="text"
                        value={titleDraft}
                        onChange={(event) => {
                            setTitleDraft(event.target.value);
                            setSaved(false);
                            setError(null);
                        }}
                        placeholder="Review name"
                        variant="minimal"
                        className="placeholder:text-gray-400"
                        disabled={!canEdit || saving}
                        autoFocus
                    />
                </div>

                {!lockProject && (
                    <div className="space-y-3">
                        <FieldLabel as="p">Project</FieldLabel>
                        <ToggleSwitchUI
                            checked={underProject}
                            disabled={!canEdit || saving}
                            onCheckedChange={(next) => {
                                setUnderProject(next);
                                if (!next) setSelectedProjectId("");
                                setSaved(false);
                                setError(null);
                            }}
                        >
                            Move under a project
                        </ToggleSwitchUI>

                        {underProject && (
                            <ModalSelect
                                id="tabular-review-details-project"
                                value={selectedProjectId}
                                options={projectOptions}
                                onChange={(value) => {
                                    setSelectedProjectId(value);
                                    setSaved(false);
                                    setError(null);
                                }}
                                placeholder="Select project..."
                                disabled={
                                    !canEdit || saving || projects.length === 0
                                }
                            />
                        )}
                    </div>
                )}
            </div>
        </Modal>
    );
}
