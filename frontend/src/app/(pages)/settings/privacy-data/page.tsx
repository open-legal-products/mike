"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Trash2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import {
  deleteAllChats,
  deleteAllMemories,
  deleteAllProjects,
  deleteAllTabularReviews,
  downloadUserExport,
  getUserExportStatus,
  isMfaRequiredError,
  startUserExport,
  type UserExportType,
} from "@/app/lib/mikeApi";

type DeleteDataAction = "chats" | "tabular-reviews" | "projects" | "memory";
type ExportDataAction =
  | "export-chats"
  | "export-tabular-reviews"
  | "export-account"
  | "export-memory";
type MfaRetryAction = DeleteDataAction | ExportDataAction;

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

type DeleteDataCopyKey =
  | "confirmarExcluirConversasTitulo"
  | "confirmarExcluirRevisoesTitulo"
  | "confirmarExcluirProjetosTitulo"
  | "confirmarExcluirMemoriaTitulo"
  | "confirmarExcluirConversasCorpo"
  | "confirmarExcluirRevisoesCorpo"
  | "confirmarExcluirProjetosCorpo"
  | "confirmarExcluirMemoriaCorpo";

const DELETE_DATA_COPY: Record<
  DeleteDataAction,
  {
    titleKey: DeleteDataCopyKey;
    messageKey: DeleteDataCopyKey;
  }
> = {
  chats: {
    titleKey: "confirmarExcluirConversasTitulo",
    messageKey: "confirmarExcluirConversasCorpo",
  },
  "tabular-reviews": {
    titleKey: "confirmarExcluirRevisoesTitulo",
    messageKey: "confirmarExcluirRevisoesCorpo",
  },
  projects: {
    titleKey: "confirmarExcluirProjetosTitulo",
    messageKey: "confirmarExcluirProjetosCorpo",
  },
  memory: {
    titleKey: "confirmarExcluirMemoriaTitulo",
    messageKey: "confirmarExcluirMemoriaCorpo",
  },
};

export default function PrivacyDataPage() {
  const t = useTranslations("configuracoes.privacidade");
  const tComum = useTranslations("common");
  const { loadChats, setCurrentChatId } = useChatHistoryContext();
  const [pendingDeleteAction, setPendingDeleteAction] =
    useState<DeleteDataAction | null>(null);
  const [deletingAction, setDeletingAction] = useState<DeleteDataAction | null>(
    null,
  );
  const [pendingMfaAction, setPendingMfaAction] =
    useState<MfaRetryAction | null>(null);
  const [isExportingAccount, setIsExportingAccount] = useState(false);
  const [isExportingChats, setIsExportingChats] = useState(false);
  const [isExportingTabularReviews, setIsExportingTabularReviews] =
    useState(false);
  const [isExportingMemory, setIsExportingMemory] = useState(false);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Exports run as durable backend jobs: schedule, poll until built, then
  // download the artifact. A double click dedupes onto the running job
  // server-side, and a build that outlives this tab can be re-downloaded by
  // clicking the button again (the poll finds the finished job).
  const EXPORT_POLL_MS = process.env.NODE_ENV === "test" ? 10 : 2000;
  const EXPORT_POLL_LIMIT = 150; // ~5 minutes
  const runAsyncExport = async (
    type: UserExportType,
    fallbackFilename: string,
  ) => {
    const { export_id } = await startUserExport(type);
    for (let i = 0; i < EXPORT_POLL_LIMIT; i++) {
      await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS));
      const status = await getUserExportStatus(export_id);
      if (status.status === "failed") {
        throw new Error(t("erroFalhaGeracao"));
      }
      if (status.status === "done") {
        const { blob, filename } = await downloadUserExport(export_id);
        downloadBlob(blob, filename ?? status.filename ?? fallbackFilename);
        return;
      }
    }
    throw new Error(t("erroTempoEsgotado"));
  };

  const handleExportAccountData = async () => {
    devLog("[privacy-data/mfa] export account requested");
    setIsExportingAccount(true);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction("export-account");
        return;
      }
      await runAsyncExport("account", "mike-account-export.json");
    } catch (error) {
      devLog("[privacy-data/mfa] export account failed", {
        isMfaRequired: isMfaRequiredError(error),
        error,
      });
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("export-account");
        return;
      }
      alert(t("erroExportarConta"));
    } finally {
      setIsExportingAccount(false);
    }
  };

  const handleExportChatData = async () => {
    devLog("[privacy-data/mfa] export chats requested");
    setIsExportingChats(true);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction("export-chats");
        return;
      }
      await runAsyncExport("chats", "mike-chat-export.json");
    } catch (error) {
      devLog("[privacy-data/mfa] export chats failed", {
        isMfaRequired: isMfaRequiredError(error),
        error,
      });
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("export-chats");
        return;
      }
      alert(t("erroExportarConversas"));
    } finally {
      setIsExportingChats(false);
    }
  };

  const handleExportTabularReviewsData = async () => {
    devLog("[privacy-data/mfa] export tabular reviews requested");
    setIsExportingTabularReviews(true);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction("export-tabular-reviews");
        return;
      }
      await runAsyncExport(
        "tabular-reviews",
        "mike-tabular-reviews-export.json",
      );
    } catch (error) {
      devLog("[privacy-data/mfa] export tabular reviews failed", {
        isMfaRequired: isMfaRequiredError(error),
        error,
      });
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("export-tabular-reviews");
        return;
      }
      alert(t("erroExportarRevisoes"));
    } finally {
      setIsExportingTabularReviews(false);
    }
  };

  const handleExportMemoryData = async () => {
    devLog("[privacy-data/mfa] export memory requested");
    setIsExportingMemory(true);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction("export-memory");
        return;
      }
      await runAsyncExport("memory-zip", "mike-memory-export.zip");
    } catch (error) {
      devLog("[privacy-data/mfa] export memory failed", {
        isMfaRequired: isMfaRequiredError(error),
        error,
      });
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("export-memory");
        return;
      }
      alert(t("erroExportarMemoria"));
    } finally {
      setIsExportingMemory(false);
    }
  };

  const handleDeleteData = async (action: DeleteDataAction) => {
    devLog("[privacy-data/mfa] delete requested", { action });
    setDeletingAction(action);
    try {
      if (await needsMfaVerification()) {
        setPendingDeleteAction(null);
        setPendingMfaAction(action);
        return;
      }
      if (action === "chats") {
        await deleteAllChats();
        setCurrentChatId(null);
        await loadChats();
      } else if (action === "tabular-reviews") {
        await deleteAllTabularReviews();
      } else if (action === "memory") {
        await deleteAllMemories();
      } else {
        await deleteAllProjects();
        setCurrentChatId(null);
        await loadChats();
      }
      setPendingDeleteAction(null);
    } catch (error) {
      devLog("[privacy-data/mfa] delete failed", {
        action,
        isMfaRequired: isMfaRequiredError(error),
        error,
      });
      if (isMfaRequiredError(error)) {
        setPendingDeleteAction(null);
        setPendingMfaAction(action);
        return;
      }
      alert(t("erroExcluir"));
    } finally {
      setDeletingAction(null);
    }
  };

  const handleMfaVerified = async () => {
    const action = pendingMfaAction;
    devLog("[privacy-data/mfa] verification callback", { action });
    setPendingMfaAction(null);
    if (!action) return;

    if (action === "export-account") {
      await handleExportAccountData();
    } else if (action === "export-chats") {
      await handleExportChatData();
    } else if (action === "export-tabular-reviews") {
      await handleExportTabularReviewsData();
    } else if (action === "export-memory") {
      await handleExportMemoryData();
    } else {
      await handleDeleteData(action);
    }
  };

  const pendingDeleteCopy = pendingDeleteAction
    ? DELETE_DATA_COPY[pendingDeleteAction]
    : null;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>{t("tituloExportar")}</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>{t("exportarConversas")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoExportarConversas")}
              </SettingsDescription>
            </div>
            <PillButton
              tone="black"
              size="sm"
              onClick={handleExportChatData}
              disabled={isExportingChats}
              loading={isExportingChats}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingChats ? t("exportando") : t("exportar")}
            </PillButton>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>{t("exportarRevisoes")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoExportarRevisoes")}
              </SettingsDescription>
            </div>
            <PillButton
              tone="black"
              size="sm"
              onClick={handleExportTabularReviewsData}
              disabled={isExportingTabularReviews}
              loading={isExportingTabularReviews}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingTabularReviews ? t("exportando") : t("exportar")}
            </PillButton>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>{t("exportarConta")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoExportarConta")}
              </SettingsDescription>
            </div>
            <PillButton
              tone="black"
              size="sm"
              onClick={handleExportAccountData}
              disabled={isExportingAccount}
              loading={isExportingAccount}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingAccount ? t("exportando") : t("exportar")}
            </PillButton>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>{t("exportarMemoria")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoExportarMemoria")}
              </SettingsDescription>
            </div>
            <PillButton
              tone="black"
              size="sm"
              aria-label={t("exportarMemoria")}
              onClick={handleExportMemoryData}
              disabled={isExportingMemory}
              loading={isExportingMemory}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingMemory ? t("exportando") : t("exportar")}
            </PillButton>
          </SettingsRow>
        </SettingsCard>
      </section>

      <section className="space-y-3">
        <SettingsHeading>{t("tituloExcluir")}</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>{t("excluirConversas")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoExcluirConversas")}
              </SettingsDescription>
            </div>
            <PillButton
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("chats")}
              disabled={!!deletingAction}
              loading={deletingAction === "chats"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              {tComum("delete")}
            </PillButton>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>{t("excluirRevisoes")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoExcluirRevisoes")}
              </SettingsDescription>
            </div>
            <PillButton
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("tabular-reviews")}
              disabled={!!deletingAction}
              loading={deletingAction === "tabular-reviews"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              {tComum("delete")}
            </PillButton>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>{t("excluirProjetos")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoExcluirProjetos")}
              </SettingsDescription>
            </div>
            <PillButton
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("projects")}
              disabled={!!deletingAction}
              loading={deletingAction === "projects"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              {tComum("delete")}
            </PillButton>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>{t("excluirMemoria")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoExcluirMemoria")}
              </SettingsDescription>
            </div>
            <PillButton
              tone="danger"
              size="sm"
              aria-label={t("excluirMemoria")}
              onClick={() => setPendingDeleteAction("memory")}
              disabled={!!deletingAction}
              loading={deletingAction === "memory"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              {tComum("delete")}
            </PillButton>
          </SettingsRow>
        </SettingsCard>
      </section>
      <ConfirmPopup
        open={!!pendingDeleteAction}
        title={pendingDeleteCopy ? t(pendingDeleteCopy.titleKey) : undefined}
        message={
          pendingDeleteCopy ? t(pendingDeleteCopy.messageKey) : undefined
        }
        confirmLabel={tComum("delete")}
        confirmVariant="danger"
        confirmStatus={deletingAction ? "loading" : "idle"}
        cancelLabel={tComum("cancel")}
        onCancel={() => {
          if (deletingAction) return;
          setPendingDeleteAction(null);
        }}
        onConfirm={() => {
          if (!pendingDeleteAction) return;
          void handleDeleteData(pendingDeleteAction);
        }}
      />
      <MfaVerificationPopup
        open={!!pendingMfaAction}
        onCancel={() => setPendingMfaAction(null)}
        onVerified={() => void handleMfaVerified()}
        title={t("tituloVerificacao")}
        message={t("mensagemVerificacao")}
      />
    </div>
  );
}
