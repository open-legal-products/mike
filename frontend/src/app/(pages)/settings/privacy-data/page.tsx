"use client";

import { useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
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

const DELETE_DATA_COPY: Record<
  DeleteDataAction,
  {
    title: string;
    message: string;
  }
> = {
  chats: {
    title: "Delete all chats?",
    message:
      "This will permanently delete your assistant and tabular review chat history. This action cannot be undone.",
  },
  "tabular-reviews": {
    title: "Delete all tabular reviews?",
    message:
      "This will permanently delete all tabular reviews you own, including their cells and review chats. This action cannot be undone.",
  },
  projects: {
    title: "Delete all projects?",
    message:
      "This will permanently delete all projects you own, including their documents, chats, and tabular reviews. This action cannot be undone.",
  },
  memory: {
    title: "Delete all memory?",
    message:
      "This permanently deletes your app memory and memories for private projects you created. Project collaborators will also lose those memories. Memory remains enabled and can be rebuilt from future conversations. This action cannot be undone.",
  },
};

export default function PrivacyDataPage() {
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
  const [warningMessage, setWarningMessage] = useState<string | null>(null);

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
      if (status.status === "failed") throw new Error("Export build failed");
      if (status.status === "done") {
        const { blob, filename } = await downloadUserExport(export_id);
        downloadBlob(blob, filename ?? status.filename ?? fallbackFilename);
        return;
      }
    }
    throw new Error("Export timed out");
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
      setWarningMessage("Failed to export account data. Please try again.");
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
      setWarningMessage("Failed to export chats. Please try again.");
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
      setWarningMessage("Failed to export tabular reviews. Please try again.");
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
      setWarningMessage("Failed to export memory. Please try again.");
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
      setWarningMessage("Failed to delete data. Please try again.");
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
        <SettingsHeading>Export data</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Export chats</SettingsLabel>
              <SettingsDescription>
                Download assistant and tabular review chat history as JSON.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              onClick={handleExportChatData}
              disabled={isExportingChats}
              loading={isExportingChats}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingChats ? "Exporting..." : "Export"}
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Export tabular reviews</SettingsLabel>
              <SettingsDescription>
                Download all owned tabular reviews, cells, and review chat
                records as JSON.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              onClick={handleExportTabularReviewsData}
              disabled={isExportingTabularReviews}
              loading={isExportingTabularReviews}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingTabularReviews ? "Exporting..." : "Export"}
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Export account JSON</SettingsLabel>
              <SettingsDescription>
                Download account metadata, projects, document metadata,
                workflows, and review data as JSON.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              onClick={handleExportAccountData}
              disabled={isExportingAccount}
              loading={isExportingAccount}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingAccount ? "Exporting..." : "Export"}
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Export memory</SettingsLabel>
              <SettingsDescription>
                Download your app memory and every project memory you can access
                as Markdown files in a ZIP archive.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="black"
              size="sm"
              aria-label="Export memory"
              onClick={handleExportMemoryData}
              disabled={isExportingMemory}
              loading={isExportingMemory}
              className="shrink-0"
            >
              <Download className="h-4 w-4 shrink-0" />
              {isExportingMemory ? "Exporting..." : "Export"}
            </PillButtonUI>
          </SettingsRow>
        </SettingsCard>
      </section>

      <section className="space-y-3">
        <SettingsHeading>Delete data</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Delete all chats</SettingsLabel>
              <SettingsDescription>
                Permanently delete your assistant and tabular review chat
                history.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("chats")}
              disabled={!!deletingAction}
              loading={deletingAction === "chats"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Delete all tabular reviews</SettingsLabel>
              <SettingsDescription>
                Permanently delete all tabular reviews you own, including cells
                and review chats.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("tabular-reviews")}
              disabled={!!deletingAction}
              loading={deletingAction === "tabular-reviews"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Delete all projects</SettingsLabel>
              <SettingsDescription>
                Permanently delete all projects you own, including documents,
                chats, and tabular reviews.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              onClick={() => setPendingDeleteAction("projects")}
              disabled={!!deletingAction}
              loading={deletingAction === "projects"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete
            </PillButtonUI>
          </SettingsRow>
          <SettingsRow>
            <div className="space-y-1">
              <SettingsLabel>Delete all memory</SettingsLabel>
              <SettingsDescription>
                Permanently delete your app memory and memories for private
                projects you created.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              aria-label="Delete all memory"
              onClick={() => setPendingDeleteAction("memory")}
              disabled={!!deletingAction}
              loading={deletingAction === "memory"}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Delete
            </PillButtonUI>
          </SettingsRow>
        </SettingsCard>
      </section>
      <ConfirmPopup
        open={!!pendingDeleteAction}
        title={pendingDeleteCopy?.title}
        message={pendingDeleteCopy?.message}
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={deletingAction ? "loading" : "idle"}
        cancelLabel="Cancel"
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
        title="Two-factor verification required"
        message="This action is sensitive. Enter a code from your authenticator app to continue."
      />
      <WarningPopup
        open={!!warningMessage}
        title="Action failed"
        message={warningMessage}
        onClose={() => setWarningMessage(null)}
      />
    </div>
  );
}
