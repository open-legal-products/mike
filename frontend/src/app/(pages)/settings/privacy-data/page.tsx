"use client";

import { useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import {
  PERSONAL_WORKSPACE,
  PERSONAL_WORKSPACE_LABEL,
  useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { useHasMultipleWorkspaces } from "@/app/hooks/useHasMultipleWorkspaces";
import { useMemberDataActions } from "@/app/hooks/useMemberDataActions";
import { EmptyState } from "@/app/components/ui/empty-state";
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
import { UserVisibleError, notifyError } from "@/app/lib/userFacingError";

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

/**
 * The confirmation for deleting data in one workspace. Each "Delete all"
 * reaches the active workspace only. `workspaceName` is set when the person
 * has more than one workspace, and the copy then says which; with only
 * Personal there is nothing to tell apart, and it names none.
 */
function deleteDataCopy(
  action: DeleteDataAction,
  personal: boolean,
  workspaceName: string | null,
): { title: string; message: string } {
  const where = workspaceName ? ` in ${workspaceName}` : "";
  const others = workspaceName
    ? " Your other workspaces are not affected."
    : "";
  const undo = "This action cannot be undone.";
  switch (action) {
    case "chats":
      return {
        title: `Delete all chats${where}?`,
        message: `This will permanently delete your assistant and tabular review chat history${where}.${others} ${undo}`,
      };
    case "tabular-reviews":
      return {
        title: `Delete all tabular reviews${where}?`,
        message: `This will permanently delete all tabular reviews you own${where}, including their cells and review chats.${others} ${undo}`,
      };
    case "projects":
      return {
        title: `Delete all projects${where}?`,
        message: personal
          ? `This will permanently delete all projects you own${where}, including their documents, chats, and tabular reviews.${others} ${undo}`
          : `This will permanently delete all projects you created${where}, including their documents, chats, and tabular reviews. Colleagues lose them too.${others} ${undo}`,
      };
    case "memory":
      return {
        title: `Delete all memory${where}?`,
        message: personal
          ? `This permanently deletes your ${workspaceName ? `${workspaceName} memory` : "app memory"} and memories for private projects you created. Project collaborators will also lose those memories.${others} Memory remains enabled and can be rebuilt from future conversations. ${undo}`
          : `This permanently deletes your memory${where}. Project memories there are not affected, and neither are your other workspaces. Memory remains enabled and can be rebuilt from future conversations. ${undo}`,
      };
  }
}

/** Imperative, lower case: "Couldn't delete your chats". */
const DELETE_ACTION_LABELS: Record<DeleteDataAction, string> = {
  chats: "delete your chats",
  "tabular-reviews": "delete your tabular reviews",
  projects: "delete your projects",
  memory: "delete your memory",
};

// Exports and deletion work on the active workspace, and in an organization
// only as far as its owners allow members. Keyed by workspace, so switching
// drops a confirmation or verification still open for the old one rather
// than carrying it into the new one.
export default function PrivacyDataPage() {
  const { workspaceId, activeOrganization } = useWorkspace();
  const multipleWorkspaces = useHasMultipleWorkspaces();
  const { canExport, canDelete } = useMemberDataActions();
  const workspace = workspaceId ?? PERSONAL_WORKSPACE;
  if (!canExport && !canDelete) {
    return (
      <EmptyState
        title="Managed by your organization"
        description={`Exporting and bulk-deleting your data in ${activeOrganization?.name ?? "this organization"} is managed by its owners and is not available to members. Your other workspaces are not affected.`}
      />
    );
  }
  return (
    <PrivacyData
      key={workspace}
      workspace={workspace}
      workspaceName={
        multipleWorkspaces
          ? (activeOrganization?.name ?? PERSONAL_WORKSPACE_LABEL)
          : null
      }
      canExport={canExport}
      canDelete={canDelete}
    />
  );
}

function PrivacyData({
  workspace,
  workspaceName,
  canExport,
  canDelete,
}: {
  /** "personal" or an organization id. */
  workspace: string;
  /** The workspace's name when the person has more than one, else null. */
  workspaceName: string | null;
  canExport: boolean;
  canDelete: boolean;
}) {
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
    const { export_id } = await startUserExport(type, { workspace });
    for (let i = 0; i < EXPORT_POLL_LIMIT; i++) {
      await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS));
      const status = await getUserExportStatus(export_id);
      if (status.status === "failed") {
        throw new UserVisibleError(
          "Mike couldn't build the export. Try again, and contact support if it keeps happening.",
          { retryable: true },
        );
      }
      if (status.status === "done") {
        const { blob, filename } = await downloadUserExport(export_id);
        downloadBlob(blob, filename ?? status.filename ?? fallbackFilename);
        return;
      }
    }
    throw new UserVisibleError(
      "The export is taking longer than expected. It may still be building, so try again in a few minutes.",
      { retryable: true },
    );
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
      notifyError(error, {
        action: "export your account data",
        onRetry: () => void handleExportAccountData(),
      });
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
      notifyError(error, {
        action: "export your chats",
        onRetry: () => void handleExportChatData(),
      });
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
      notifyError(error, {
        action: "export your tabular reviews",
        onRetry: () => void handleExportTabularReviewsData(),
      });
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
      notifyError(error, {
        action: "export your memory",
        onRetry: () => void handleExportMemoryData(),
      });
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
        await deleteAllChats(workspace);
        setCurrentChatId(null);
        await loadChats();
      } else if (action === "tabular-reviews") {
        await deleteAllTabularReviews(workspace);
      } else if (action === "memory") {
        await deleteAllMemories(workspace);
      } else {
        await deleteAllProjects(workspace);
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
      notifyError(error, {
        action: DELETE_ACTION_LABELS[action],
        // Re-open the confirmation rather than deleting again from the
        // notice: this erases data permanently, so it is always the dialog
        // that starts it.
        onRetry: () => setPendingDeleteAction(action),
      });
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

  const personal = workspace === PERSONAL_WORKSPACE;
  const pendingDeleteCopy = pendingDeleteAction
    ? deleteDataCopy(pendingDeleteAction, personal, workspaceName)
    : null;

  return (
    <div className="space-y-8">
      {canExport && (
        <section className="space-y-3">
          <SettingsHeading id="export-data">Export data</SettingsHeading>
          {workspaceName && (
            <SettingsDescription>
              Exports data in {workspaceName} only. To export another workspace,
              switch to it first.
            </SettingsDescription>
          )}
          <GlassCardUI>
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
                  {workspace === PERSONAL_WORKSPACE
                    ? "Download account metadata, projects, document metadata, workflows, playbooks, and review data as JSON."
                    : "Download your projects, document metadata, workflows, playbooks, and review data here as JSON."}
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
                  Download your app memory and every project memory you can
                  access as Markdown files in a ZIP archive.
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
          </GlassCardUI>
        </section>
      )}

      {canDelete && (
        <section className="space-y-3">
          <SettingsHeading id="delete-data">Delete data</SettingsHeading>
          {workspaceName && (
            <SettingsDescription>
              Deletes data in {workspaceName} only. To delete data in another
              workspace, switch to it first.
            </SettingsDescription>
          )}
          <GlassCardUI>
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
                  Permanently delete all tabular reviews you own, including
                  cells and review chats.
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
                  {personal
                    ? "Permanently delete all projects you own, including documents, chats, and tabular reviews."
                    : "Permanently delete all projects you created here, including documents, chats, and tabular reviews."}
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
                  {!personal
                    ? `Permanently delete your memory in ${workspaceName ?? "this workspace"}.`
                    : workspaceName
                      ? `Permanently delete your ${workspaceName} memory and memories for private projects you created.`
                      : "Permanently delete your app memory and memories for private projects you created."}
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
          </GlassCardUI>
        </section>
      )}
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
    </div>
  );
}
