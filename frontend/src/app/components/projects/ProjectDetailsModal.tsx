"use client";

import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import {
    FieldLabel,
    FormTextInput,
} from "@/app/components/ui/form-field";
import { AccessVisibilityField } from "@/app/components/modals/AccessVisibilityField";
import type {
    ContentVisibility,
    Project,
} from "@/app/components/shared/types";
import { listOrgs, type Org } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { ProjectPracticeField } from "./ProjectPracticeField";

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
        /** Sent only for an organization's project, and only when changed. */
        visibility?: ContentVisibility;
    }) => Promise<void>;
    onShareProject?: () => void;
}

export function ProjectDetailsModal({
    open,
    project,
    canEdit,
    onClose,
    onSave,
    onShareProject,
}: ProjectDetailsModalProps) {
    const [nameDraft, setNameDraft] = useState("");
    const [cmDraft, setCmDraft] = useState("");
    const [practiceDraft, setPracticeDraft] = useState("");
    const [visibilityDraft, setVisibilityDraft] =
        useState<ContentVisibility>("private");
    const [orgs, setOrgs] = useState<Org[]>([]);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const projectId = project?.id ?? null;
    const projectName = project?.name ?? "";
    const projectCmNumber = project?.cm_number ?? "";
    const projectPractice = project?.practice ?? "";
    const projectVisibility: ContentVisibility =
        project?.visibility ?? "private";

    useEffect(() => {
        if (!open || !projectId) return;
        setNameDraft(projectName);
        setCmDraft(projectCmNumber);
        setPracticeDraft(projectPractice);
        setVisibilityDraft(projectVisibility);
        setSaved(false);
        setError(null);
    }, [
        open,
        projectId,
        projectName,
        projectCmNumber,
        projectPractice,
        projectVisibility,
    ]);

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
            trimmedPractice !== (project.practice ?? "") ||
            (!!project.org_id &&
                visibilityDraft !== (project.visibility ?? "private"))
        );
    }, [project, trimmedCm, trimmedName, trimmedPractice, visibilityDraft]);

    // The select falls back to rendering its raw value when no option matches,
    // so a failed (or still pending) listOrgs used to show the organization's
    // UUID. The row already carries the name — use it.
    const orgOptions = useMemo(() => {
        const options = [
            { value: PERSONAL_WORKSPACE, label: "No organization" },
            ...orgs.map((org) => ({ value: org.id, label: org.name })),
        ];
        if (
            project?.org_id &&
            !options.some((option) => option.value === project.org_id)
        ) {
            options.push({
                value: project.org_id,
                label: project.organization_name ?? "Organisation",
            });
        }
        return options;
    }, [orgs, project?.org_id, project?.organization_name]);

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
                ...(project?.org_id &&
                visibilityDraft !== (project.visibility ?? "private")
                    ? { visibility: visibilityDraft }
                    : {}),
            });
            setSaved(true);
        } catch (err: unknown) {
            // An intentional 4xx (a name conflict, a refusal) says something
            // the generic line cannot; anything else still falls back to it.
            setError(
                userFacingApiError(err, "Could not update project details."),
            );
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Projects", project.name, "Details"]}
            secondaryAction={
                onShareProject
                    ? {
                          label: "Share",
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
                        options={orgOptions}
                    />
                </div>

                {project.org_id ? (
                    <AccessVisibilityField
                        visibility={visibilityDraft}
                        onChange={(next) => {
                            setVisibilityDraft(next);
                            setSaved(false);
                            setError(null);
                        }}
                        organizationName={project.organization_name}
                        resourceNoun="project"
                        disabled={!canEdit || saving}
                    />
                ) : null}
            </div>
        </Modal>
    );
}
