"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { MarkdownEditor } from "@/app/components/ui/markdown-editor";
import { PillButton } from "@/app/components/ui/pill-button";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import {
  MemoryConflictNotice,
  MemorySaveStatus,
  useMemoryActivityLabel,
} from "@/app/components/memory/MemoryEditorState";
import { MemoryUpdateFailedPopup } from "@/app/components/memory/MemoryUpdateFailedPopup";
import { useMemoryFileController } from "@/app/components/memory/useMemoryFileController";
import {
  getUserMemory,
  setUserMemoryEnabled,
  updateUserMemory,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

type ConfirmAction = "disable";

export function UserMemoryPage() {
  const t = useTranslations("memoria");
  const [settingsMutation, setSettingsMutation] = useState<
    "enable" | "disable" | null
  >(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const loadMemory = useCallback(
    (signal?: AbortSignal) => getUserMemory(signal),
    [],
  );
  const saveMemory = useCallback(
    (content: string, revision: number) => updateUserMemory(content, revision),
    [],
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
    canEdit: true,
    mutationBlocked: !!confirmAction || settingsMutation !== null,
    flushOnUnmount: settingsMutation === null,
    loadMemory,
    saveMemory,
    conflictLoadError: t("erroConflitoRecarregar"),
    saveError: t("erroSalvarRascunhoMantido"),
  });

  const memoryActivity = useMemoryActivityLabel(memory);

  const interactionLocked =
    autosave.inFlight || settingsMutation !== null || confirmAction !== null;
  const editorLocked = settingsMutation !== null || confirmAction !== null;

  async function enableMemory() {
    if (interactionLocked) return;
    setSettingsMutation("enable");
    setError(null);
    try {
      syncCurrent(await setUserMemoryEnabled(true));
    } catch (cause) {
      setError(
        userFacingApiError(cause, t("erroAtivar")),
      );
    } finally {
      setSettingsMutation(null);
    }
  }

  async function confirmSettingsMutation() {
    if (!confirmAction || settingsMutation || autosave.inFlight) return;
    setSettingsMutation("disable");
    setError(null);
    try {
      const current = await setUserMemoryEnabled(false);
      syncCurrent(current);
      setConfirmAction(null);
    } catch (cause) {
      setError(
        userFacingApiError(cause, t("erroDesativar")),
      );
      setConfirmAction(null);
    } finally {
      setSettingsMutation(null);
    }
  }

  return (
    <div className="space-y-8">
      <section
        className="space-y-3"
        aria-labelledby="app-memory-settings-heading"
      >
        <SettingsHeading id="app-memory-settings-heading">
          {t("titulo")}
        </SettingsHeading>

        <SettingsCard>
          {loading ? (
            <div
              className="flex items-center justify-between gap-3 px-4 py-5"
              aria-label={t("carregandoConfiguracoes")}
            >
              <div className="space-y-2">
                <div className="h-4 w-36 animate-pulse rounded bg-gray-200" />
                <div className="h-3 w-72 max-w-full animate-pulse rounded bg-gray-100" />
              </div>
              <div className="h-5 w-9 animate-pulse rounded-full bg-gray-200" />
            </div>
          ) : loadError || !memory ? (
            <SettingsRow>
              <div className="space-y-1">
                <SettingsLabel>
                  {t("configuracoesIndisponiveis")}
                </SettingsLabel>
                <p className="text-sm text-red-600" role="alert">
                  {t("erroCarregarConfiguracoes")}
                </p>
              </div>
              <PillButton tone="white" size="sm" onClick={() => void load()}>
                {t("tentarNovamente")}
              </PillButton>
            </SettingsRow>
          ) : (
            <SettingsRow>
              <div className="space-y-1">
                <SettingsLabel>{t("memoriaAplicativo")}</SettingsLabel>
                <SettingsDescription>
                  {t("descricaoMemoriaAplicativo")}
                </SettingsDescription>
              </div>
              <div className="flex items-center gap-3">
                <ToggleSwitch
                  checked={memory.enabled}
                  disabled={interactionLocked}
                  aria-busy={settingsMutation === "enable"}
                  aria-label={t("memoriaAplicativo")}
                  onCheckedChange={(enabled) => {
                    if (enabled) void enableMemory();
                    else {
                      autosave.cancelPending();
                      setConfirmAction("disable");
                    }
                  }}
                />
              </div>
            </SettingsRow>
          )}

          <ProjectMemoryDefaultRow />
        </SettingsCard>

        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {loading ? (
        <MemoryEditorSkeleton />
      ) : memory?.enabled ? (
        <section
          className="space-y-3"
          aria-labelledby="app-memory-file-heading"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <SettingsHeading id="app-memory-file-heading">
              {t("tituloArquivoMemoria")}
            </SettingsHeading>
            <div className="flex flex-wrap items-center gap-3">
              <MemorySaveStatus
                error={autosaveError}
                status={autosave.status}
                compact
                onRetry={() => {
                  setAutosaveError(null);
                  autosave.retry();
                }}
              />
              {memoryActivity ? (
                <p className="text-xs text-gray-400" role="status">
                  {memoryActivity}
                </p>
              ) : null}
            </div>
          </div>

          {conflict ? (
            <MemoryConflictNotice
              onReload={useLatestConflict}
              onKeepDraft={keepDraftAfterConflict}
            />
          ) : null}

          <div className="min-h-[24rem]">
            <MarkdownEditor
              value={draft}
              onChange={(value) => {
                changeDraft(value);
              }}
              ariaLabel={t("memoriaAplicativo")}
              className="min-h-[24rem]"
              suspended={editorLocked}
              allowTables={false}
            />
          </div>
        </section>
      ) : null}

      <ConfirmPopup
        open={confirmAction !== null}
        title={t("tituloConfirmarDesativar")}
        message={t("corpoConfirmarDesativar", {
          rascunho: dirty ? "true" : "false",
        })}
        confirmLabel={t("desativar")}
        confirmVariant="danger"
        confirmStatus={settingsMutation ? "loading" : "idle"}
        onConfirm={() => void confirmSettingsMutation()}
        onCancel={() => {
          if (!settingsMutation) setConfirmAction(null);
        }}
      />
      <MemoryUpdateFailedPopup memory={memory} scopeKey="app" />
    </div>
  );
}

/**
 * The per-user default applied to projects this account creates. It is a
 * profile preference rather than a memory-file setting, so it stays usable
 * even when the memory file itself cannot be loaded, and it never overrides
 * another owner's choice on an existing project.
 */
function ProjectMemoryDefaultRow() {
  const t = useTranslations("memoria");
  const { profile, updateProjectMemoryDefault } = useUserProfile();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(enabled: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateProjectMemoryDefault(enabled);
    } catch (cause) {
      setError(userFacingApiError(cause, t("erroSalvarPreferencia")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow>
      <div className="space-y-1">
        <SettingsLabel>{t("memoriaProjetosNovos")}</SettingsLabel>
        <SettingsDescription>
          {t("descricaoMemoriaProjetos")}
        </SettingsDescription>
        {error ? (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <ToggleSwitch
        checked={profile?.projectMemoryDefault !== false}
        disabled={!profile || saving}
        aria-busy={saving}
        aria-label={t("memoriaProjetosNovos")}
        onCheckedChange={(enabled) => void handleToggle(enabled)}
      />
    </SettingsRow>
  );
}

function MemoryEditorSkeleton() {
  const t = useTranslations("memoria");
  return (
    <div className="space-y-3" aria-label={t("carregandoEditor")}>
      <div className="space-y-2">
        <div className="h-7 w-36 animate-pulse rounded bg-gray-200" />
        <div className="h-3 w-full max-w-xl animate-pulse rounded bg-gray-100" />
      </div>
      <div className="h-96 animate-pulse rounded-2xl bg-app-surface" />
    </div>
  );
}
