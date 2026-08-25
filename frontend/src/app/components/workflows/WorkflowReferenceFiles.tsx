"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { WorkflowReferenceDocument } from "../shared/types";
import {
  deleteWorkflowReferenceFile,
  failedUploadMessage,
  getWorkflowReferenceUrl,
  listWorkflowReferenceFiles,
  replaceWorkflowReferenceFile,
  uploadWorkflowReferenceFiles,
} from "@/app/lib/mikeApi";
import {
  SUPPORTED_DOCUMENT_ACCEPT,
  formatUnsupportedDocumentWarning,
  partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { EmptyState } from "@/app/components/ui/empty-state";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { RowActions } from "../shared/RowActions";
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

const REFERENCE_NAME_COL_W =
  "w-[292px] sm:w-[332px] md:w-[392px] lg:w-[452px] shrink-0";

function formatBytes(bytes: number | null) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export interface WorkflowReferenceFilesHandle {
  openUploadPicker: () => void;
  uploadFiles: (files: File[]) => void;
}

export const WorkflowReferenceFiles = forwardRef<
  WorkflowReferenceFilesHandle,
  {
    workflowId: string;
    readOnly: boolean;
    onUploadingChange?: (uploading: boolean) => void;
  }
>(function WorkflowReferenceFiles(
  { workflowId, readOnly, onUploadingChange },
  ref,
) {
  const [files, setFiles] = useState<WorkflowReferenceDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pendingDeleteFile, setPendingDeleteFile] =
    useState<WorkflowReferenceDocument | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<"idle" | "loading">("idle");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<WorkflowReferenceDocument | null>(null);
  // Synchronous guard against overlapping upload batches: drops and the file
  // picker can both call upload() before React re-renders `busyId`.
  const uploadInFlightRef = useRef(false);

  useImperativeHandle(ref, () => ({
    openUploadPicker: () => uploadInputRef.current?.click(),
    uploadFiles: (filesToUpload) => void upload(filesToUpload),
  }));

  useEffect(() => {
    onUploadingChange?.(busyId === "upload");
    return () => onUploadingChange?.(false);
  }, [busyId, onUploadingChange]);

  async function reload() {
    try {
      setFiles(await listWorkflowReferenceFiles(workflowId));
      setError("");
    } catch (caught) {
      setError(userFacingApiError(caught, "Unable to load reference files."));
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
      const outcomes = await uploadWorkflowReferenceFiles(
        workflowId,
        supported.map((file) => ({ file })),
      );
      const created = outcomes.flatMap((outcome) =>
        outcome.status === "completed" && outcome.result
          ? [outcome.result]
          : [],
      );
      setFiles((current) => [...current, ...created]);
      const failedCount = outcomes.length - created.length;
      if (failedCount > 0) {
        appendWarning(failedUploadMessage(outcomes));
      }
    } catch (caught) {
      appendWarning(userFacingApiError(caught, "Upload failed."));
    } finally {
      uploadInFlightRef.current = false;
      setBusyId(null);
    }
  }

  async function replace(file: File) {
    const target = replaceTargetRef.current;
    if (!target) return;
    setBusyId(target.id);
    try {
      await replaceWorkflowReferenceFile(workflowId, target.id, file);
      await reload();
    } catch (caught) {
      setError(userFacingApiError(caught, "Replacement failed."));
    } finally {
      replaceTargetRef.current = null;
      setBusyId(null);
    }
  }

  async function download(file: WorkflowReferenceDocument) {
    setBusyId(file.id);
    try {
      const resolved = await getWorkflowReferenceUrl(workflowId, file.id);
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

  async function confirmRemove() {
    const file = pendingDeleteFile;
    if (!file) return;
    setDeleteStatus("loading");
    setBusyId(file.id);
    try {
      await deleteWorkflowReferenceFile(workflowId, file.id);
      setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (caught) {
      setError(userFacingApiError(caught, "Delete failed."));
    } finally {
      setBusyId(null);
      setPendingDeleteFile(null);
      setDeleteStatus("idle");
    }
  }

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
        ref={replaceInputRef}
        type="file"
        accept={SUPPORTED_DOCUMENT_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void replace(file);
        }}
      />
      {error && (
        <p className="mx-4 mb-2 -mt-1 text-xs text-red-600 md:mx-8">{error}</p>
      )}
      <TableScrollArea
        header={
          <TableHeaderRow>
            <TableStickyCell header widthClassName={REFERENCE_NAME_COL_W}>
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
                  widthClassName={REFERENCE_NAME_COL_W}
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
              title="Reference files"
              description="Upload files that this workflow can reference when it runs."
            />
          </TableEmptyState>
        ) : (
          <TableBody>
            {files.map((file) => (
              <TableRow key={file.id} interactive={false}>
                <TableStickyCell widthClassName={REFERENCE_NAME_COL_W}>
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
                    onDownload={() => void download(file)}
                    onUploadNewVersion={
                      readOnly
                        ? undefined
                        : () => {
                            replaceTargetRef.current = file;
                            replaceInputRef.current?.click();
                          }
                    }
                    uploadNewVersionLabel="Replace file"
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
      <ConfirmPopup
        open={pendingDeleteFile !== null}
        title="Delete reference file?"
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
