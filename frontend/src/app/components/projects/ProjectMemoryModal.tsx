"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Brain } from "lucide-react";
import {
    MemoryConflictNotice,
    MemorySaveStatus,
    useMemoryActivityLabel,
} from "@/app/components/memory/MemoryEditorState";
import { MemoryUpdateFailedPopup } from "@/app/components/memory/MemoryUpdateFailedPopup";
import { useMemoryFileController } from "@/app/components/memory/useMemoryFileController";
import { Modal } from "@/app/components/modals/Modal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import { FieldLabel } from "@/app/components/ui/form-field";
import { GlassCard } from "@/app/components/ui/glass-card";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { PillButton } from "@/app/components/ui/pill-button";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";
import {
    getProjectMemory,
    setProjectMemoryEnabled,
    updateProjectMemory,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

export function ProjectMemoryModal({
    open,
    onClose,
    projectId,
    projectName,
    projectLoading = false,
    canEdit,
    canManage,
    onMemoryEnabledChange,
}: {
    open: boolean;
    onClose: () => void;
    projectId: string;
    projectName: string | null;
    projectLoading?: boolean;
    /** Caller holds `content.edit` on this project. */
    canEdit: boolean;
    /** Caller holds `access.manage` on this project. */
    canManage: boolean;
    /** Report the file's enabled flag back to the surface that opened it. */
    onMemoryEnabledChange?: (enabled: boolean) => void;
}) {
    const t = useTranslations("modals.memoriaProjeto");
    const tPagina = useTranslations("projects.pagina");
    const [settingsMutation, setSettingsMutation] = useState<
        "enable" | "disable" | null
    >(null);
    const [disableMemoryConfirmOpen, setDisableMemoryConfirmOpen] =
        useState(false);
    const [closing, setClosing] = useState(false);
    const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
    const [savedNotice, setSavedNotice] = useState<string | null>(null);
    const loadMemory = useCallback(
        (signal?: AbortSignal) => getProjectMemory(projectId, signal),
        [projectId],
    );
    const saveMemory = useCallback(
        (content: string, revision: number) =>
            updateProjectMemory(projectId, content, revision),
        [projectId],
    );
    const handleCurrentChange = useCallback(
        (current: Awaited<ReturnType<typeof getProjectMemory>>) => {
            onMemoryEnabledChange?.(current.enabled);
        },
        [onMemoryEnabledChange],
    );
    const {
        memory,
        draft,
        loading,
        loadError,
        conflict,
        error,
        autosaveError,
        dirty,
        autosave,
        load,
        syncCurrent,
        changeDraft,
        setError,
        setAutosaveError,
        useLatestConflict,
        keepDraftAfterConflict,
    } = useMemoryFileController({
        active: open,
        canEdit,
        mutationBlocked:
            settingsMutation !== null ||
            disableMemoryConfirmOpen ||
            discardConfirmOpen,
        pollBlocked: closing,        flushOnUnmount: open && canEdit && settingsMutation === null,
        loadMemory,
        saveMemory,
        conflictLoadError: t("conflitoEdicao"),
        saveError: t("erroSalvar"),
        onCurrentChange: handleCurrentChange,
    });
    const atividadeMemoria = useMemoryActivityLabel(memory);

    useEffect(() => {
        if (!open) {
            setSavedNotice(null);
            setClosing(false);
            setSettingsMutation(null);
            setDisableMemoryConfirmOpen(false);
            setDiscardConfirmOpen(false);
        }
    }, [open]);

    async function persistMemoryEnabled(enabled: boolean) {
        if (!canManage || settingsMutation || closing || autosave.inFlight)
            return;
        setSettingsMutation(enabled ? "enable" : "disable");
        setError(null);
        setAutosaveError(null);
        try {
            const current = await setProjectMemoryEnabled(projectId, enabled);
            syncCurrent(current);
            setDisableMemoryConfirmOpen(false);
            setSavedNotice(enabled ? t("habilitada") : null);
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    enabled
                        ? t("erroHabilitar")
                        : t("erroDesabilitar"),
                ),
            );
            setDisableMemoryConfirmOpen(false);
        } finally {
            setSettingsMutation(null);
        }
    }

    async function requestClose() {
        if (disableMemoryConfirmOpen) {
            if (!settingsMutation) setDisableMemoryConfirmOpen(false);
            return;
        }
        if (discardConfirmOpen) {
            setDiscardConfirmOpen(false);
            return;
        }
        if (closing || settingsMutation) return;
        const canSaveCurrent = canEdit && !!memory?.enabled && !loadError;
        if (!dirty || !canSaveCurrent) {
            onClose();
            return;
        }

        if (autosaveError || conflict) {
            autosave.cancelPending();
            setDiscardConfirmOpen(true);
            return;
        }

        setClosing(true);
        const saved = await autosave.flush();
        if (saved) onClose();
        else {
            setClosing(false);
            autosave.cancelPending();
            setDiscardConfirmOpen(true);
        }
    }

    return (
        <Modal
            open={open}
            onClose={requestClose}
            breadcrumbs={[
                tPagina("projetos"),
                projectName ?? t("projeto"),
                t("memoriaProjeto"),
            ]}
            headerAction={
                memory?.enabled && atividadeMemoria ? (
                    <p className="text-xs text-gray-400" role="status">
                        {atividadeMemoria}
                    </p>
                ) : undefined
            }
            footerStatus={
                error ? (
                    <span className="text-sm text-red-600" role="alert">
                        {error}
                    </span>
                ) : autosaveError || autosave.status !== "idle" ? (
                    <MemorySaveStatus
                        error={autosaveError}
                        status={autosave.status}
                        onRetry={() => {
                            setAutosaveError(null);
                            autosave.retry();
                        }}
                    />
                ) : savedNotice ? (
                    <span className="text-sm text-gray-400" role="status">
                        {savedNotice}
                    </span>
                ) : null
            }
            primaryAction={{
                label: t("concluido"),
                type: "button",
                onClick: () => void requestClose(),
                disabled: closing || settingsMutation !== null,
                "aria-busy": closing,
            }}
        >
            <div className="flex min-h-0 flex-1 flex-col gap-3 pb-3 pt-1">
                {loading || projectLoading ? (
                    <ProjectMemorySkeleton />
                ) : loadError || !memory ? (
                    <GlassCard>
                        <EmptyState
                            icon={<Brain />}
                            title={t("erroCarregar")}
                            description={t("erroCarregarDescricao")}
                            tone="error"
                            className="px-5 py-8"
                            action={
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    onClick={() => void load()}
                                >
                                    {t("repetir")}
                                </PillButton>
                            }
                        />
                    </GlassCard>
                ) : (
                    <>
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <FieldLabel as="p">{t("titulo")}</FieldLabel>
                                <p className="text-sm text-gray-500">
                                    {t("descricao")}
                                </p>
                            </div>
                            <ToggleSwitch
                                checked={memory.enabled}
                                onCheckedChange={(enabled) => {
                                    setSavedNotice(null);
                                    if (enabled)
                                        void persistMemoryEnabled(true);
                                    else {
                                        autosave.cancelPending();
                                        setDisableMemoryConfirmOpen(true);
                                    }
                                }}
                                disabled={
                                    !canManage ||
                                    closing ||
                                    autosave.inFlight ||
                                    settingsMutation !== null ||
                                    disableMemoryConfirmOpen ||
                                    discardConfirmOpen
                                }
                                aria-label={t("habilitarAria")}
                                aria-busy={settingsMutation !== null}
                            />
                        </div>

                        {!memory.enabled ? (
                            <GlassCard>
                                <EmptyState
                                    icon={<Brain />}
                                    title={t("desligadaTitulo")}
                                    description={
                                        canManage
                                            ? t("desligadaGerenciavel")
                                            : t("desligadaSomenteLeitura")
                                    }
                                    className="px-5 py-8"
                                />
                            </GlassCard>
                        ) : (
                            <>
                                {conflict ? (
                                    <MemoryConflictNotice
                                        project
                                        onReload={useLatestConflict}
                                        onKeepDraft={keepDraftAfterConflict}
                                    />
                                ) : null}

                                <div className="min-h-0 flex-1">
                                    <MarkdownEditor
                                        value={draft}
                                        onChange={
                                            canEdit
                                                ? (value) => {
                                                      changeDraft(value);
                                                      setSavedNotice(null);
                                                  }
                                                : undefined
                                        }
                                        readOnly={!canEdit}
                                        // A confirmation or a settings write
                                        // pauses editing; it does not make the
                                        // file read-only, so the editor dims
                                        // instead of relabelling itself.
                                        suspended={
                                            settingsMutation !== null ||
                                            closing ||
                                            disableMemoryConfirmOpen ||
                                            discardConfirmOpen
                                        }
                                        ariaLabel={t("memoriaProjeto")}
                                        className="h-full"
                                        allowTables={false}
                                    />
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>

            <ConfirmPopup
                open={disableMemoryConfirmOpen}
                title={t("desligarTitulo")}
                message={
                    dirty
                        ? t("desligarMensagemRascunho")
                        : t("desligarMensagem")
                }
                confirmLabel={t("desabilitar")}
                confirmVariant="danger"
                confirmStatus={
                    settingsMutation === "disable" ? "loading" : "idle"
                }
                onCancel={() => {
                    if (!settingsMutation) setDisableMemoryConfirmOpen(false);
                }}
                onConfirm={() => void persistMemoryEnabled(false)}
            />

            <ConfirmPopup
                open={discardConfirmOpen}
                title={t("fecharTitulo")}
                message={t("fecharMensagem")}
                confirmLabel={t("fecharSemSalvar")}
                confirmVariant="danger"
                onConfirm={() => {
                    autosave.cancelPending();
                    setDiscardConfirmOpen(false);
                    onClose();
                }}
                onCancel={() => setDiscardConfirmOpen(false)}
            />
            <MemoryUpdateFailedPopup
                memory={memory}
                scopeKey={`project:${projectId}`}
            />
        </Modal>
    );
}

function ProjectMemorySkeleton() {
    const t = useTranslations("modals.memoriaProjeto");
    return (
        <div className="space-y-4" aria-label={t("carregando")}>
            <div className="space-y-2">
                <div className="h-3 w-full max-w-xl animate-pulse rounded bg-gray-100" />
                <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
            </div>
            <div className="h-80 animate-pulse rounded-2xl bg-app-surface" />
        </div>
    );
}
