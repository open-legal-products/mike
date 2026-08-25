import React, { useEffect, useRef, useState } from "react";
import type { WorkflowReferenceDocument } from "../../types";
import {
  deleteWorkflowReferenceFile,
  getWorkflowReferenceUrl,
  listWorkflowReferenceFiles,
  replaceWorkflowReferenceFile,
  uploadWorkflowReferenceFiles,
} from "../../api/mikeApi";

/**
 * Open a URL in the system browser. Office's openBrowserWindow is the
 * sanctioned way out of the task-pane webview — window.open is blocked in
 * some hosts (notably desktop Word), where it silently does nothing. Fall
 * back to window.open when the API isn't available (hermetic e2e bundle,
 * older hosts).
 */
function openExternalUrl(url: string): void {
  const ui = typeof Office !== "undefined" ? Office.context?.ui : undefined;
  if (ui && typeof ui.openBrowserWindow === "function") {
    ui.openBrowserWindow(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function WorkflowReferenceFiles({
  workflowId,
  readOnly,
}: {
  workflowId: string;
  readOnly: boolean;
}): React.ReactElement {
  const [files, setFiles] = useState<WorkflowReferenceDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<WorkflowReferenceDocument | null>(null);

  const reload = async (): Promise<void> => {
    setFiles(await listWorkflowReferenceFiles(workflowId));
  };

  useEffect(() => {
    // Guard against out-of-order responses when the user switches workflows
    // quickly, and surface failures instead of rendering an empty list.
    let cancelled = false;
    listWorkflowReferenceFiles(workflowId)
      .then((rows) => {
        if (!cancelled) {
          setFiles(rows);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setFiles([]);
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load reference files",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const outcomes = await uploadWorkflowReferenceFiles(workflowId, [file]);
      await reload();
      setError(
        outcomes.some((outcome) => outcome.status === "error")
          ? `${file.name} could not be uploaded. Please try again.`
          : null,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const replace = async (file: File): Promise<void> => {
    if (!replaceTarget.current) return;
    setBusy(true);
    try {
      await replaceWorkflowReferenceFile(
        workflowId,
        replaceTarget.current.id,
        file,
      );
      await reload();
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Replacement failed");
    } finally {
      replaceTarget.current = null;
      setBusy(false);
    }
  };

  return (
    <section className="mt-2 shrink-0 rounded-xl border border-white/70 bg-white/55 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium text-gray-700">Reference files</p>
          <p className="mt-0.5 text-[11px] text-gray-400">
            Available when this workflow runs.
          </p>
        </div>
        {!readOnly && (
          <button
            type="button"
            disabled={busy}
            onClick={() => uploadRef.current?.click()}
            className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-600 disabled:opacity-50"
          >
            Add file
          </button>
        )}
      </div>
      <input
        ref={uploadRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
      <input
        ref={replaceRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void replace(file);
        }}
      />
      {files.length === 0 ? (
        <p className="mt-2 text-[11px] text-gray-400">No reference files.</p>
      ) : (
        <div className="mt-2 max-h-24 space-y-1 overflow-y-auto">
          {files.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 rounded-md bg-white/55 px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-gray-600">
                {file.filename}
              </span>
              <button
                type="button"
                onClick={() =>
                  void getWorkflowReferenceUrl(workflowId, file.id)
                    .then(({ url }) => openExternalUrl(url))
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : "Download failed",
                      ),
                    )
                }
                className="text-[10px] text-gray-500"
              >
                Download
              </button>
              {!readOnly && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      replaceTarget.current = file;
                      replaceRef.current?.click();
                    }}
                    className="text-[10px] text-gray-500"
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void deleteWorkflowReferenceFile(workflowId, file.id)
                        .then(reload)
                        .catch((reason: unknown) =>
                          setError(
                            reason instanceof Error
                              ? reason.message
                              : "Delete failed",
                          ),
                        )
                    }
                    className="text-[10px] text-red-500"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
