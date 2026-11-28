"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Document } from "../shared/types";
import {
  copyDocumentsToWorkflowAssets,
  deleteDocumentVersion,
  deleteWorkflowAsset,
  failedUploadMessage,
  uploadOutcomeNeedsRetry,
  getDocumentUrl,
  listDocumentVersions,
  listWorkflowAssets,
  renameDocumentVersion,
  replaceDocumentVersionFile,
  uploadDocumentVersion,
  uploadWorkflowAssets,
  type DocumentVersion,
} from "@/app/lib/mikeApi";
import {
  SUPPORTED_DOCUMENT_ACCEPT,
  formatUnsupportedDocumentWarning,
  partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import { reportFault,
    notifyError,
    notifyPartialFailure,
    uploadBatchFault,
    userFacingApiError,
} from "@/app/lib/userFacingError";
import { EmptyState } from "@/app/components/ui/empty-state";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { RowActionMenuItems, RowActions } from "../shared/RowActions";
import { SelectionActionsMenu } from "../shared/SelectionActionsMenu";
import { settleBulkRequests } from "@/app/lib/bulkRequests";
import { DocumentSidePanel } from "../shared/DocumentSidePanel";
import {
  SkeletonCheckbox,
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
  rowActionSelectionIds,
  selectedIdsAfterRangeClick,
  selectedIdsAfterShiftClick,
} from "../shared/TablePrimitive";

/** Every failure on this screen belongs to the workflow it serves. */
const ASSET_FLOW = { operation: "workflows.run" } as const;

const ASSET_NAME_COL_W =
  "w-[292px] sm:w-[332px] md:w-[392px] lg:w-[452px] shrink-0";

function formatBytes(bytes: number | null) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export interface WorkflowAssetsHandle {
  openUploadPicker: () => void;
  uploadFiles: (files: File[]) => void;
  addSavedDocuments: (documents: Document[]) => void;
}

export const WorkflowAssets = forwardRef<
  WorkflowAssetsHandle,
  {
    workflowId: string;
    readOnly: boolean;
    onUploadingChange?: (uploading: boolean) => void;
    /**
     * Draws the page's toolbar above the table, with the selection's
     * "Actions" menu while assets are selected.
     */
    renderToolbar?: (actions: ReactNode) => ReactNode;
  }
>(function WorkflowAssets(
  { workflowId, readOnly, onUploadingChange, renderToolbar },
  ref,
) {
  const [files, setFiles] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewingFileId, setViewingFileId] = useState<string | null>(null);
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null);
  const [versionsByAssetId, setVersionsByAssetId] = useState<
    Map<
      string,
      { currentVersionId: string | null; versions: DocumentVersion[] }
    >
  >(() => new Map());
  const [loadingVersionAssetIds, setLoadingVersionAssetIds] = useState<
    Set<string>
  >(() => new Set());
  const [error, setError] = useState("");
  const [pendingDeleteFiles, setPendingDeleteFiles] = useState<Document[]>(
    [],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Where a shift-click range starts: the last row selected on its own.
  const selectionAnchorIdRef = useRef<string | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<"idle" | "loading">("idle");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const versionUploadInputRef = useRef<HTMLInputElement>(null);
  const versionUploadTargetRef = useRef<Document | null>(null);
  // Synchronous guard against overlapping upload batches: drops and the file
  // picker can both call upload() before React re-renders `busyId`.
  const uploadInFlightRef = useRef(false);

  useImperativeHandle(ref, () => ({
    openUploadPicker: () => uploadInputRef.current?.click(),
    uploadFiles: (filesToUpload) => void upload(filesToUpload),
    addSavedDocuments: (documents) => void addSavedDocuments(documents),
  }));

  useEffect(() => {
    onUploadingChange?.(busyId === "upload");
    return () => onUploadingChange?.(false);
  }, [busyId, onUploadingChange]);

  async function reload() {
    try {
      setFiles(await listWorkflowAssets(workflowId));
      setError("");
    } catch (caught) {
      reportFault(caught, ASSET_FLOW);
      setError(userFacingApiError(caught, "Unable to load assets."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // workflowId is the complete identity for this collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  // Adds a warning without discarding what is already shown, so messages
  // from one upload batch (e.g. skipped unsupported files) survive later
  // failures instead of being clobbered.
  function appendWarning(message: string) {
    if (!message) return;
    setError((current) =>
      current && current !== message ? `${current} ${message}` : message,
    );
  }

  function uploadAction(failedCount: number, total: number) {
    if (failedCount === 1 && total === 1) return "upload this file";
    return failedCount === total
      ? `upload ${total} files`
      : `upload ${failedCount} of ${total} files`;
  }

  async function upload(filesToUpload: File[]) {
    if (uploadInFlightRef.current) {
      appendWarning(
        "An upload is already in progress. Wait for it to finish, then add the files again.",
      );
      return;
    }
    const { supported, unsupported } =
      partitionSupportedDocumentFiles(filesToUpload);
    if (supported.length === 0) {
      setError(formatUnsupportedDocumentWarning(unsupported) ?? "");
      return;
    }
    uploadInFlightRef.current = true;
    setBusyId("upload");
    setError(formatUnsupportedDocumentWarning(unsupported) ?? "");
    try {
      const outcomes = await uploadWorkflowAssets(
        workflowId,
        supported.map((file) => ({ file })),
      );
      const created = outcomes.flatMap((outcome) =>
        outcome.status === "completed" && outcome.result
          ? [outcome.result]
          : [],
      );
      setFiles((current) => [...current, ...created]);
      // The upload client returns one outcome per input, in input order.
      // Filenames are not identities: separate files can share a name.
      const failedFiles = supported.filter((_, index) => outcomes[index]?.status === "error");
      // A Retry re-sends only the failures that could still land; a file the
      // server refused for its content is reported but not re-sent.
      const retryableFiles = supported.filter((_, index) => {
        const outcome = outcomes[index];
        return outcome !== undefined && uploadOutcomeNeedsRetry(outcome);
      });
      if (failedFiles.length > 0) {
        // One notification for the batch, naming the files that did not make
        // it, with a retry that re-runs only those that can.
        notifyPartialFailure(
          failedUploadMessage(outcomes),
          {
            action: uploadAction(failedFiles.length, supported.length),
            onRetry:
              retryableFiles.length > 0
                ? () => void upload(retryableFiles)
                : undefined,
            // Storage failures were reported per part by the API client;
            // what is left to report is a file the server never finished.
            ...ASSET_FLOW,
            cause: uploadBatchFault(outcomes) ?? undefined,
          },
        );
      }
    } catch (caught) {
      notifyError(caught, {
        action: uploadAction(supported.length, supported.length),
        ...ASSET_FLOW,
        fallback:
          supported.length === 1
            ? `${supported[0]?.name ?? "That file"} could not be uploaded. Try again.`
            : "Those files could not be uploaded. Try again.",
        onRetry: () => void upload(supported),
      });
    } finally {
      uploadInFlightRef.current = false;
      setBusyId(null);
    }
  }

  async function addSavedDocuments(documents: Document[]) {
    if (documents.length === 0) return;
    if (uploadInFlightRef.current) {
      appendWarning(
        "Files are already being added. Wait for them to finish, then add the saved files again.",
      );
      return;
    }
    uploadInFlightRef.current = true;
    setBusyId("upload");
    setError("");
    try {
      const created = await copyDocumentsToWorkflowAssets(
        workflowId,
        documents.map((document) => document.id),
      );
      setFiles((current) => [...current, ...created]);
    } catch (caught) {
      reportFault(caught, ASSET_FLOW);
      setError(userFacingApiError(caught, "Unable to add saved files."));
    } finally {
      uploadInFlightRef.current = false;
      setBusyId(null);
    }
  }

  async function loadVersions(assetId: string, force = false) {
    if (!force && versionsByAssetId.has(assetId)) return;
    setLoadingVersionAssetIds((current) => new Set(current).add(assetId));
    try {
      const result = await listDocumentVersions(assetId);
      setVersionsByAssetId((current) => {
        const next = new Map(current);
        next.set(assetId, {
          currentVersionId: result.current_version_id,
          versions: result.versions,
        });
        return next;
      });
    } catch (caught) {
      reportFault(caught, ASSET_FLOW);
      setError(userFacingApiError(caught, "Unable to load asset versions."));
    } finally {
      setLoadingVersionAssetIds((current) => {
        const next = new Set(current);
        next.delete(assetId);
        return next;
      });
    }
  }

  async function refreshVersionState(assetId: string) {
    await reload();
    await loadVersions(assetId, true);
  }

  async function uploadVersion(file: File) {
    const target = versionUploadTargetRef.current;
    versionUploadTargetRef.current = null;
    if (!target) return;
    setBusyId(target.id);
    try {
      await uploadDocumentVersion(target.id, file, file.name);
      setViewingVersionId(null);
      await refreshVersionState(target.id);
    } catch (caught) {
      reportFault(caught, ASSET_FLOW);
      setError(userFacingApiError(caught, "Version upload failed."));
    } finally {
      setBusyId(null);
    }
  }

  async function download(file: Document, versionId?: string | null) {
    setBusyId(file.id);
    try {
      const resolved = await getDocumentUrl(file.id, versionId);
      const anchor = document.createElement("a");
      anchor.href = resolved.url;
      anchor.download = resolved.filename || file.filename;
      anchor.click();
    } catch (caught) {
      reportFault(caught, ASSET_FLOW);
      setError(userFacingApiError(caught, "Download failed."));
    } finally {
      setBusyId(null);
    }
  }

  function view(file: Document) {
    setViewingFileId(file.id);
    setViewingVersionId(null);
  }

  async function deleteAsset(file: Document) {
    await deleteWorkflowAsset(workflowId, file.id);
    setFiles((current) => current.filter((item) => item.id !== file.id));
    setSelectedIds((current) => current.filter((id) => id !== file.id));
    setViewingFileId((current) => (current === file.id ? null : current));
    setVersionsByAssetId((current) => {
      const next = new Map(current);
      next.delete(file.id);
      return next;
    });
  }

  async function confirmRemove() {
    const targets = pendingDeleteFiles;
    if (targets.length === 0) return;
    setDeleteStatus("loading");
    setBusyId(targets.length === 1 ? targets[0].id : "delete");
    try {
      const outcome = await settleBulkRequests(targets, deleteAsset);
      if (outcome.failed.length > 0) {
        reportFault(outcome.firstError, ASSET_FLOW);
        setError(
          targets.length === 1
            ? userFacingApiError(outcome.firstError, "Delete failed.")
            : `${outcome.failed.length} of ${targets.length} assets could not be deleted.`,
        );
      }
    } finally {
      setBusyId(null);
      setPendingDeleteFiles([]);
      setDeleteStatus("idle");
    }
  }

  async function downloadAll(targets: Document[]) {
    for (const file of targets) await download(file);
  }

  const selectedIdSet = new Set(selectedIds);
  const allSelected =
    files.length > 0 && files.every((file) => selectedIdSet.has(file.id));
  const someSelected = files.some((file) => selectedIdSet.has(file.id));

  // A selected row's menu acts on the whole selection, like the toolbar's.
  function renderAssetActions(file: Document | undefined, onClose: () => void) {
    const ids = file ? rowActionSelectionIds(file.id, selectedIds) : selectedIds;
    const targets = files.filter((item) => ids.includes(item.id));
    const only = targets.length === 1 ? targets[0] : undefined;
    const inSelection = !file || selectedIdSet.has(file.id);
    return (
      <RowActionMenuItems
        onClose={onClose}
        onDeselect={
          inSelection && selectedIds.length > 0
            ? () => setSelectedIds([])
            : undefined
        }
        onView={only ? () => view(only) : undefined}
        onDownload={
          targets.length > 0 ? () => void downloadAll(targets) : undefined
        }
        onUploadNewVersion={
          only && !readOnly
            ? () => {
                versionUploadTargetRef.current = only;
                versionUploadInputRef.current?.click();
              }
            : undefined
        }
        uploadNewVersionLabel="Upload new version"
        onDelete={
          !readOnly && targets.length > 0
            ? () => setPendingDeleteFiles(targets)
            : undefined
        }
        deleteLabel={
          targets.length > 1 ? `Delete ${targets.length} assets` : undefined
        }
        deleteDisabled={
          busyId === "delete" || targets.some((item) => item.id === busyId)
        }
      />
    );
  }

  const viewingFile = files.find((file) => file.id === viewingFileId) ?? null;
  const viewingVersions = viewingFile
    ? versionsByAssetId.get(viewingFile.id)
    : undefined;

  return (
    <>
      {renderToolbar?.(
        selectedIds.length > 0 ? (
          <SelectionActionsMenu
            renderItems={(close) => renderAssetActions(undefined, close)}
          />
        ) : undefined,
      )}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        accept={SUPPORTED_DOCUMENT_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const selectedFiles = Array.from(event.target.files ?? []);
          event.target.value = "";
          void upload(selectedFiles);
        }}
      />
      <input
        ref={versionUploadInputRef}
        type="file"
        accept={SUPPORTED_DOCUMENT_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadVersion(file);
        }}
      />
      {error && (
        <p
          role="alert"
          className="mx-4 mb-2 -mt-1 text-xs text-red-600 md:mx-3"
        >
          {error}
        </p>
      )}
      <TableScrollArea
        header={
          <TableHeaderRow>
            <TableStickyCell header widthClassName={ASSET_NAME_COL_W}>
              <input
                type="checkbox"
                aria-label="Select all assets"
                className={TABLE_CHECKBOX_CLASS}
                disabled={loading || files.length === 0}
                checked={allSelected}
                ref={(node) => {
                  if (node) node.indeterminate = someSelected && !allSelected;
                }}
                onChange={(event) => {
                  selectionAnchorIdRef.current = null;
                  setSelectedIds(
                    event.target.checked ? files.map((file) => file.id) : [],
                  );
                }}
              />
              Name
            </TableStickyCell>
            <TableHeaderCell className="ml-auto w-20">Type</TableHeaderCell>
            <TableHeaderCell className="w-24">Size</TableHeaderCell>
            <TableHeaderCell className="w-32">Updated</TableHeaderCell>
            <TableHeaderCell className="w-8" />
          </TableHeaderRow>
        }
      >
        {loading ? (
          <TableBody>
            {[1, 2, 3].map((index) => (
              <TableRow key={index} interactive={false}>
                <TableStickyCell
                  hover={false}
                  widthClassName={ASSET_NAME_COL_W}
                >
                  <SkeletonCheckbox />
                  <SkeletonLine className="mr-2 h-4 w-4" />
                  <SkeletonLine className="w-48" />
                </TableStickyCell>
                <TableCell className="ml-auto w-20">
                  <SkeletonLine className="w-10" />
                </TableCell>
                <TableCell className="w-24">
                  <SkeletonLine className="w-14" />
                </TableCell>
                <TableCell className="w-32">
                  <SkeletonLine className="w-20" />
                </TableCell>
                <TableCell className="w-8" />
              </TableRow>
            ))}
          </TableBody>
        ) : files.length === 0 ? (
          <TableEmptyState>
            <EmptyState
              title="Assets"
              description="Upload assets that this workflow can use when it runs."
            />
          </TableEmptyState>
        ) : (
          <TableBody>
            {files.map((file) => (
              <TableRow
                key={file.id}
                data-document-row
                role="button"
                tabIndex={0}
                selected={selectedIdSet.has(file.id)}
                rightClickDropdown={(close) => renderAssetActions(file, close)}
                onClick={(event) => {
                  if (event.shiftKey) {
                    event.preventDefault();
                    const anchorId = selectionAnchorIdRef.current;
                    setSelectedIds((current) =>
                      selectedIdsAfterRangeClick(
                        file.id,
                        files.map((item) => item.id),
                        current,
                        anchorId,
                      ),
                    );
                    selectionAnchorIdRef.current = file.id;
                    return;
                  }
                  if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    setSelectedIds((current) =>
                      selectedIdsAfterShiftClick(file.id, current),
                    );
                    selectionAnchorIdRef.current = file.id;
                    return;
                  }
                  view(file);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  view(file);
                }}
              >
                <TablePrimaryCell
                  widthClassName={ASSET_NAME_COL_W}
                  selected={selectedIdSet.has(file.id)}
                  checkboxTitle={`Select ${file.filename}`}
                  onSelectionChange={() => {
                    selectionAnchorIdRef.current = file.id;
                    setSelectedIds((current) =>
                      current.includes(file.id)
                        ? current.filter((id) => id !== file.id)
                        : [...current, file.id],
                    );
                  }}
                >
                  <FileTypeIcon
                    fileType={file.file_type || file.filename}
                    className="mr-2 h-4 w-4"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                    {file.filename}
                  </span>
                </TablePrimaryCell>
                <TableCell className="ml-auto w-20 text-xs uppercase text-gray-500">
                  {file.file_type || "—"}
                </TableCell>
                <TableCell className="w-24 text-xs text-gray-500">
                  {formatBytes(file.size_bytes)}
                </TableCell>
                <TableCell className="w-32 text-xs text-gray-500">
                  {formatDate(file.updated_at)}
                </TableCell>
                <div
                  className="flex w-8 shrink-0 justify-end"
                  onClick={(event) => event.stopPropagation()}
                >
                  <RowActions
                    renderItems={(close) => renderAssetActions(file, close)}
                  />
                </div>
              </TableRow>
            ))}
          </TableBody>
        )}
      </TableScrollArea>
      <DocumentSidePanel
        doc={viewingFile}
        readOnly={readOnly}
        versionId={viewingVersionId}
        currentVersionId={viewingVersions?.currentVersionId ?? null}
        versions={viewingVersions?.versions ?? []}
        versionsLoading={
          viewingFile ? loadingVersionAssetIds.has(viewingFile.id) : false
        }
        onClose={() => setViewingFileId(null)}
        onLoadVersions={(assetId) => loadVersions(assetId)}
        onSelectVersion={(versionId) => setViewingVersionId(versionId)}
        onDownloadDocument={async () => {
          if (viewingFile) await download(viewingFile);
        }}
        onDownloadVersion={async (_assetId, versionId) => {
          if (viewingFile) await download(viewingFile, versionId);
        }}
        onRenameVersion={async (assetId, versionId, filename) => {
          await renameDocumentVersion(assetId, versionId, filename);
          await refreshVersionState(assetId);
        }}
        onDeleteVersion={async (assetId, versionId) => {
          const result = await deleteDocumentVersion(assetId, versionId);
          setViewingVersionId(result.current_version_id);
          await refreshVersionState(assetId);
        }}
        onUploadNewVersion={async (asset, file, filename) => {
          await uploadDocumentVersion(asset.id, file, filename);
          setViewingVersionId(null);
          await refreshVersionState(asset.id);
        }}
        onReplaceVersion={async (assetId, versionId, file, filename) => {
          await replaceDocumentVersionFile(assetId, versionId, file, filename);
          await refreshVersionState(assetId);
        }}
        onDelete={async (asset) => {
          await deleteAsset(asset);
        }}
      />
      <ConfirmPopup
        open={pendingDeleteFiles.length > 0}
        title={
          pendingDeleteFiles.length > 1
            ? `Delete ${pendingDeleteFiles.length} assets?`
            : "Delete asset?"
        }
        message={
          pendingDeleteFiles.length === 1 ? (
            <p>
              <span className="font-medium text-gray-950">
                {pendingDeleteFiles[0].filename}
              </span>{" "}
              will be permanently deleted.
            </p>
          ) : pendingDeleteFiles.length > 1 ? (
            <p>
              These {pendingDeleteFiles.length} assets will be permanently
              deleted.
            </p>
          ) : undefined
        }
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={deleteStatus}
        onConfirm={() => void confirmRemove()}
        onCancel={() => {
          if (deleteStatus === "loading") return;
          setPendingDeleteFiles([]);
        }}
      />
    </>
  );
});
