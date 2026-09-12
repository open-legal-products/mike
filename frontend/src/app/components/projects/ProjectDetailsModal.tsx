"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Users } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import {
    FieldLabel,
    FormTextInput,
} from "@/app/components/ui/form-field";
import type { Project } from "@/app/components/shared/types";
import { listOrgs, type Org } from "@/app/lib/mikeApi";
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
    const t = useTranslations("modals.detalhesProjeto");
    const tPagina = useTranslations("projects.pagina");
    const [nameDraft, setNameDraft] = useState("");
    const [cmDraft, setCmDraft] = useState("");
    const [practiceDraft, setPracticeDraft] = useState("");
    const [orgs, setOrgs] = useState<Org[]>([]);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const projectId = project?.id ?? null;
    const projectName = project?.name ?? "";
    const projectCmNumber = project?.cm_number ?? "";
    const projectPractice = project?.practice ?? "";

    useEffect(() => {
        if (!open || !projectId) return;
        setNameDraft(projectName);
        setCmDraft(projectCmNumber);
        setPracticeDraft(projectPractice);
        setSaved(false);
        setError(null);
    }, [
        open,
        projectId,
        projectName,
        projectCmNumber,
        projectPractice,
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
            setError(t("erroSalvar"));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[
                tPagina("projetos"),
                project.name,
                t("detalhes"),
            ]}
            secondaryAction={
                onShareProject
                    ? {
                          label: t("compartilhar"),
                          icon: <Users className="h-4 w-4" />,
                          onClick: onShareProject,
                      }
                    : undefined
            }
            footerStatus={
                error ? (
                    <span className="text-sm text-red-600">{error}</span>
                ) : saved ? (
                    <span className="text-sm text-gray-400">
                        {t("atualizado")}
                    </span>
                ) : null
            }
            primaryAction={
                canEdit
                    ? {
                          label: saving
                              ? t("atualizando")
                              : t("atualizar"),
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
                        {t("nomeProjeto")}
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
                        placeholder={t("placeholderNomeProjeto")}
                        variant="minimal"
                    />
                </div>

                <div>
                    <FieldLabel htmlFor="project-details-cm">
                        {t("numeroCM")}
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
                        placeholder={t("placeholderCM")}
                        variant="minimal"
                        className="text-xl text-gray-600"
                    />
                </div>

                <div>
                    <FieldLabel htmlFor="project-details-practice">
                        {t("pratica")}
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
                        {t("organizacao")}
                    </FieldLabel>
                    <ModalSelect
                        id="project-details-org"
                        value={project.org_id ?? PERSONAL_WORKSPACE}
                        onChange={() => undefined}
                        disabled
                        options={[
                            {
                                value: PERSONAL_WORKSPACE,
                                label: t("semOrganizacao"),
                            },
                            ...orgs.map((org) => ({
                                value: org.id,
                                label: org.name,
                            })),
                        ]}
                    />
                </div>
            </div>
        </Modal>
    );
}
