"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";

/**
 * A document attached to something about to be sent, as a removable pill:
 * the chat composer's attachments and a playbook run's documents.
 */
export function DocumentPill({
  filename,
  fileType,
  icon,
  status,
  tone = "default",
  onOpen,
  onRemove,
  removeDisabled = false,
}: {
  filename: string;
  /** A file type or a filename; defaults to `filename`. */
  fileType?: string | null;
  /** Shown in place of the file icon, such as a progress spinner. */
  icon?: ReactNode;
  /** Read after the name by assistive technology, such as "Started". */
  status?: string;
  tone?: "default" | "error";
  onOpen?: () => void;
  onRemove?: () => void;
  removeDisabled?: boolean;
}) {
  const label = (
    <>
      {icon ?? (
        <FileTypeIcon fileType={fileType ?? filename} className="h-2.5 w-2.5" />
      )}
      <span className="max-w-[140px] truncate">{filename}</span>
      {status && <span className="sr-only">, {status}</span>}
    </>
  );
  return (
    <div
      title={status ? `${filename} · ${status}` : filename}
      className={cn(
        "inline-flex items-center rounded-[10px] text-xs",
        tone === "error" ? "text-red-600" : "text-gray-800",
        LIQUID_GLASS_FLAT_CLASS,
        !onRemove && "pr-2",
      )}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${filename}`}
          className="inline-flex min-w-0 items-center gap-1 py-0.5 pl-2 transition-colors hover:text-gray-950"
        >
          {label}
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1 py-0.5 pl-2">
          {label}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          aria-label={`Remove ${filename}`}
          className="mx-1 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-40"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}
