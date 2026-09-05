"use client";

import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
    FieldLabel,
    FormTextInput,
} from "@/app/components/ui/form-field";
import type { Project } from "@/app/components/shared/types";
import { listOrgs, type Org } from "@/app/lib/mikeApi";
import { ProjectPracticeField } from "./ProjectPracticeField";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";

const PERSONAL_WORKSPACE = "__personal__";

interface ProjectDetailsModalProps {
    open: boolean;
    project: Project | null;
    canEdit: boolean;
    onClose: () => void;
    onSave: (values: {
        name: string;
        cmNumber: string;
        practice: string;
    }) => Promise<void>;
    onMemoryEnabledChange?: (enabled: boolean) => Promise<void>;
    onShareProject?: () => void;
}

export function ProjectDetailsModal({
    open,
    project,
    canEdit,
    onClose,
    onSave,
    onMemoryEnabledChange,
    onShareProject,
}: ProjectDetailsModalProps) {
    const [nameDraft, setNameDraft] = useState("");
    const [cmDraft, setCmDraft] = useState("");
    const [practiceDraft, setPracticeDraft] = useState("");
    const [orgs, setOrgs] = useState<Org[]>([]);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [memoryEnabled, setMemoryEnabled] = useState(false);
    const [memorySaving, setMemorySaving] = useState(false);
    const [disableMemoryConfirmOpen, setDisableMemoryConfirmOpen] =
        useState(false);
    const projectId = project?.id ?? null;
    const projectName = project?.name ?? "";
    const projectCmNumber = project?.cm_number ?? "";
    const projectPractice = project?.practice ?? "";
    const projectMemoryEnabled = project?.memory_enabled ?? false;

    useEffect(() => {
        if (!open || !projectId) return;
        setNameDraft(projectName);
        setCmDraft(projectCmNumber);
        setPracticeDraft(projectPractice);
        setDisableMemoryConfirmOpen(false);
        setMemorySaving(false);
        setSaved(false);
        setError(null);
    }, [
        open,
        projectId,
        projectName,
        projectCmNumber,
        projectPractice,
    ]);

    // Memory is persisted independently from the details form. Syncing this
    // field must not reset unsaved name, CM number, or practice edits when the
    // parent replaces its project object with the PATCH response.
    useEffect(() => {
        if (!open || !projectId) return;
        setMemoryEnabled(projectMemoryEnabled);
    }, [open, projectId, projectMemoryEnabled]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        listOrgs()
            .then((rows) => {
                if (!cancelled) setOrgs(rows);
            })
            .catch(() => {
                if (!cancelled) setOrgs([]);
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    const trimmedName = nameDraft.trim();
    const trimmedCm = cmDraft.trim();
    const trimmedPractice = practiceDraft.trim();
    const hasChanges = useMemo(() => {
        if (!project) return false;
        return (
            trimmedName !== project.name ||
            trimmedCm !== (project.cm_number ?? "") ||
            trimmedPractice !== (project.practice ?? "")
        );
    }, [project, trimmedCm, trimmedName, trimmedPractice]);

    if (!project) return null;

    async function handleSave() {
        if (!canEdit || saving || !hasChanges || !trimmedName) return;
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            await onSave({
                name: trimmedName,
                cmNumber: trimmedCm,
                practice:
                    trimmedPractice && trimmedPractice !== "Other"
                        ? trimmedPractice
                        : "",
            });
            setSaved(true);
        } catch {
            setError("Could not update project details.");
        } finally {
            setSaving(false);
        }
    }

    async function persistMemoryEnabled(enabled: boolean) {
        if (!canEdit || memorySaving || !onMemoryEnabledChange) return;
        setMemorySaving(true);
        setSaved(false);
        setError(null);
        try {
            await onMemoryEnabledChange(enabled);
            setMemoryEnabled(enabled);
            setDisableMemoryConfirmOpen(false);
            setSaved(true);
        } catch {
            setError(
                enabled
                    ? "Could not enable project memory."
                    : "Could not disable and delete project memory.",
            );
        } finally {
            setMemorySaving(false);
        }
    }

    function handleMemoryEnabledChange(enabled: boolean) {
        if (!enabled) {
            setDisableMemoryConfirmOpen(true);
            return;
        }
        void persistMemoryEnabled(true);
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Projects", project.name, "Details"]}
            secondaryAction={
                onShareProject
                    ? {
                          label: "Share Project",
                          icon: <Users className="h-4 w-4" />,
                          onClick: onShareProject,
                      }
                    : undefined
            }
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
                          label: saving ? "Updating..." : "Update",
                          onClick: () => void handleSave(),
                          disabled: saving || !hasChanges || !trimmedName,
                      }
                    : undefined
            }
            cancelAction={canEdit ? undefined : false}
        >
            <div className="flex min-h-0 flex-1 flex-col gap-6 py-1">
                <div>
                    <FieldLabel htmlFor="project-details-name">
                        Project name
                    </FieldLabel>
                    <FormTextInput
                        id="project-details-name"
                        value={nameDraft}
                        onChange={(e) => {
                            setNameDraft(e.target.value);
                            setSaved(false);
                            setError(null);
                        }}
                        disabled={!canEdit || saving}
                        placeholder="Add project name"
                        variant="minimal"
                    />
                </div>

                <div>
                    <FieldLabel htmlFor="project-details-cm">
                        CM number
                    </FieldLabel>
                    <FormTextInput
                        id="project-details-cm"
                        value={cmDraft}
                        onChange={(e) => {
                            setCmDraft(e.target.value);
                            setSaved(false);
                            setError(null);
                        }}
                        disabled={!canEdit || saving}
                        placeholder="Add a CM number..."
                        variant="minimal"
                        className="text-xl text-gray-600"
                    />
                </div>

                <div>
                    <FieldLabel htmlFor="project-details-practice">
                        Practice
                    </FieldLabel>
                    <ProjectPracticeField
                        id="project-details-practice"
                        value={practiceDraft}
                        onChange={(value) => {
                            setPracticeDraft(value);
                            setSaved(false);
                            setError(null);
                        }}
                        disabled={!canEdit || saving}
                    />
                </div>

                <div>
                    <FieldLabel htmlFor="project-details-org">
                        Organisation
                    </FieldLabel>
                    <ModalSelect
                        id="project-details-org"
                        value={project.org_id ?? PERSONAL_WORKSPACE}
                        onChange={() => undefined}
                        disabled
                        options={[
                            {
                                value: PERSONAL_WORKSPACE,
                                label: "No organization",
                            },
                            ...orgs.map((org) => ({
                                value: org.id,
                                label: org.name,
                            })),
                        ]}
                    />
                </div>

                <div>
                    <FieldLabel as="p">Project memory</FieldLabel>
                    <ToggleSwitch
                        checked={memoryEnabled}
                        onCheckedChange={handleMemoryEnabledChange}
                        disabled={
                            !canEdit || memorySaving || !onMemoryEnabledChange
                        }
                        aria-label="Enable project memory"
                        aria-busy={memorySaving}
                    >
                        Let Mike remember shared project context
                    </ToggleSwitch>
                    <p className="mt-1 text-xs text-gray-400">
                        {memoryEnabled
                            ? "Turning this off permanently deletes memory.md and its version history."
                            : "When enabled, Mike can curate a shared project memory.md after conversations."}
                    </p>
                </div>
            </div>

            <ConfirmPopup
                open={disableMemoryConfirmOpen}
                title="Turn off project memory?"
                message="This permanently deletes the project's memory.md and its complete version history. This cannot be undone."
                confirmLabel="Disable"
                confirmVariant="danger"
                confirmStatus={memorySaving ? "loading" : "idle"}
                onCancel={() => {
                    if (!memorySaving) setDisableMemoryConfirmOpen(false);
                }}
                onConfirm={() => void persistMemoryEnabled(false)}
            />
        </Modal>
    );
}
