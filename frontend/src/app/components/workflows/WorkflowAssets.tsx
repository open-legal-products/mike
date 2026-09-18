"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Document } from "../shared/types";
import {
  copyDocumentsToWorkflowAssets,
  deleteDocumentVersion,
  deleteWorkflowAsset,
  failedUploadMessage,
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
import {
  UserVisibleError,
  notifyError,
  userFacingApiError,
} from "@/app/lib/userFacingError";
import { EmptyState } from "@/app/components/ui/empty-state";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { RowActions } from "../shared/RowActions";
import { DocumentSidePanel } from "../shared/DocumentSidePanel";
import {
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "../shared/TablePrimitive";

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
  }
>(function WorkflowAssets({ workflowId, readOnly, onUploadingChange }, ref) {
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
  const [pendingDeleteFile, setPendingDeleteFile] = useState<Document | null>(
    null,
  );
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
      const failedNames = new Set(
        outcomes
          .filter((outcome) => outcome.status === "error")
          .map((outcome) => outcome.filename),
      );
      if (failedNames.size > 0) {
        // One notification for the batch, naming the files that did not make
        // it, with a retry that re-runs only those.
        notifyError(
          new UserVisibleError(failedUploadMessage(outcomes), {
            retryable: true,
          }),
          {
            action: uploadAction(failedNames.size, supported.length),
            onRetry: () =>
              void upload(
                supported.filter((file) => failedNames.has(file.name)),
              ),
          },
        );
      }
    } catch (caught) {
      notifyError(caught, {
        action: uploadAction(supported.length, supported.length),
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
    setViewingFileId((current) => (current === file.id ? null : current));
    setVersionsByAssetId((current) => {
      const next = new Map(current);
      next.delete(file.id);
      return next;
    });
  }

  async function confirmRemove() {
    const file = pendingDeleteFile;
    if (!file) return;
    setDeleteStatus("loading");
    setBusyId(file.id);
    try {
      await deleteAsset(file);
    } catch (caught) {
      setError(userFacingApiError(caught, "Delete failed."));
    } finally {
      setBusyId(null);
      setPendingDeleteFile(null);
      setDeleteStatus("idle");
    }
  }

  const viewingFile = files.find((file) => file.id === viewingFileId) ?? null;
  const viewingVersions = viewingFile
    ? versionsByAssetId.get(viewingFile.id)
    : undefined;

  return (
    <>
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
          className="mx-4 mb-2 -mt-1 text-xs text-red-600 md:mx-8"
        >
          {error}
        </p>
      )}
      <TableScrollArea
        header={
          <TableHeaderRow>
            <TableStickyCell header widthClassName={ASSET_NAME_COL_W}>
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
                onClick={() => view(file)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  view(file);
                }}
              >
                <TableStickyCell widthClassName={ASSET_NAME_COL_W}>
                  <FileTypeIcon
                    fileType={file.file_type || file.filename}
                    className="mr-2 h-4 w-4"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                    {file.filename}
                  </span>
                </TableStickyCell>
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
                    onView={() => view(file)}
                    onDownload={() => void download(file)}
                    onUploadNewVersion={
                      readOnly
                        ? undefined
                        : () => {
                            versionUploadTargetRef.current = file;
                            versionUploadInputRef.current?.click();
                          }
                    }
                    uploadNewVersionLabel="Upload new version"
                    onDelete={
                      readOnly ? undefined : () => setPendingDeleteFile(file)
                    }
                    deleteDisabled={busyId === file.id}
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
        open={pendingDeleteFile !== null}
        title="Delete asset?"
        message={
          pendingDeleteFile ? (
            <p>
              <span className="font-medium text-gray-950">
                {pendingDeleteFile.filename}
              </span>{" "}
              will be permanently deleted.
            </p>
          ) : undefined
        }
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={deleteStatus}
        onConfirm={() => void confirmRemove()}
        onCancel={() => {
          if (deleteStatus === "loading") return;
          setPendingDeleteFile(null);
        }}
      />
    </>
  );
});
