"use client";

import Image from "next/image";
import { useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { getDocumentFile } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";
import { WarningPopup } from "../popups/WarningPopup";
import { FileTypeIcon } from "./FileTypeIcon";
import { DocumentVersionPicker } from "./DocumentVersionPicker";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import { VersionChip } from "./VersionChip";
import type { PanelDocument } from "./types";
import type { DocxSaveState } from "./views/DocxRenderer.types";

type ExternalSourceLink = {
    href: string;
    label: string;
    title: string;
};

export function DocumentTitleRow({
    document,
    isReloading,
    compactActions,
    onDownload,
    saveState,
    onVersionChange,
    toolbarVisible,
    onToggleToolbar,
}: {
    document: PanelDocument;
    isReloading: boolean;
    compactActions: boolean;
    /** Export live editor bytes when available; undefined falls back to the server version. */
    onDownload?: () => Promise<void> | undefined;
    saveState?: DocxSaveState | null;
    onVersionChange?: (version: DocumentVersion) => void;
    toolbarVisible?: boolean;
    onToggleToolbar?: () => void;
}) {
    const isFile =
        document.type === "docx" ||
        document.type === "pdf" ||
        document.type === "spreadsheet";
    const versionNumber = document.version_number;

    return (
        <div className="shrink-0 px-3 py-2">
            {/* Centred against the actions: they are taller than the title,
                so top-aligning left the title floating above them. */}
            <div className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="shrink-0">
                        {document.type === "case" ||
                        document.type === "legislation" ? (
                            <Image
                                src={
                                    document.type === "case"
                                        ? "/icons/legal-sources/case-law.svg"
                                        : "/icons/legal-sources/legislation.svg"
                                }
                                alt=""
                                aria-hidden="true"
                                width={14}
                                height={14}
                                className="h-3.5 w-3.5 shrink-0 object-contain"
                            />
                        ) : (
                            <FileTypeIcon
                                fileType={document.title}
                                className="h-3.5 w-3.5"
                            />
                        )}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <h2
                            className="min-w-0 break-words text-xs font-normal text-foreground"
                            title={document.title}
                        >
                            {document.title}
                        </h2>
                        {isFile && onVersionChange ? (
                            <DocumentVersionPicker
                                key={document.document_id}
                                documentId={document.document_id}
                                versionId={document.version_id}
                                versionNumber={versionNumber}
                                onSelect={onVersionChange}
                                disabled={
                                    isReloading ||
                                    !!saveState?.dirty ||
                                    saveState?.status === "saving"
                                }
                            />
                        ) : (
                            <VersionChip n={versionNumber} />
                        )}
                    </div>
                </div>
                <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
                    {document.type === "docx" && saveState?.ready && (
                        <span
                            role="status"
                            aria-live="polite"
                            className="mr-2 text-xs text-muted-foreground"
                        >
                            {saveState.error
                                ? "Not saved"
                                : saveState.dirty ||
                                    saveState.status === "saving"
                                  ? "Saving…"
                                  : "Saved"}
                        </span>
                    )}
                    {onToggleToolbar && (
                        <TextButtonUI
                            size="sm"
                            aria-expanded={toolbarVisible}
                            title={
                                toolbarVisible
                                    ? "Hide editing toolbar"
                                    : "Show editing toolbar"
                            }
                            onClick={onToggleToolbar}
                        >
                            Edit
                        </TextButtonUI>
                    )}
                    {isFile && (
                        <DownloadButton
                            documentId={document.document_id}
                            versionId={document.version_id ?? null}
                            filename={document.title}
                            isReloading={isReloading}
                            compact={compactActions}
                            onDownload={onDownload}
                        />
                    )}
                    {(document.actions ?? []).map((action, index) =>
                        action.type === "download" ? (
                            <UrlDownloadButton
                                key={`${action.type}:${action.url}:${index}`}
                                href={action.url}
                                compact={compactActions}
                            />
                        ) : (
                            <ExternalSourceLinkButton
                                key={`${action.type}:${action.url}:${index}`}
                                link={{
                                    href: action.url,
                                    label: action.label,
                                    title: action.title ?? action.label,
                                }}
                                compact={compactActions}
                            />
                        ),
                    )}
                </div>
            </div>
            {document.type === "docx" && saveState?.error && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                    {saveState.error}
                </p>
            )}
            {document.metadata.length > 0 && (
                <div className="mt-1 flex w-full flex-wrap items-center gap-x-3 gap-y-1 font-serif text-sm text-gray-600">
                    {document.metadata.map((item, index) => (
                        <span key={`${item.label}:${item.value}:${index}`}>
                            {item.label}: {formatMetadataValue(item)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Source actions
// ---------------------------------------------------------------------------

function formatMetadataValue(item: PanelDocument["metadata"][number]): string {
    if (item.format !== "date") return item.value;
    const value = item.value;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(`${value}T00:00:00Z`)
        : new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
    }).format(date);
}

function UrlDownloadButton({
    href,
    compact,
}: {
    href: string;
    compact: boolean;
}) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            download
            aria-label="Download"
            title="Download"
            className={textButtonUIClassName({
                size: compact ? "icon-xs" : "sm",
            })}
        >
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
            <span className={compact ? "sr-only" : undefined}>Download</span>
        </a>
    );
}

function ExternalSourceLinkButton({
    link,
    compact,
}: {
    link: ExternalSourceLink;
    compact: boolean;
}) {
    return (
        <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={link.title}
            title={link.title}
            className={textButtonUIClassName({
                size: compact ? "icon-xs" : "sm",
            })}
        >
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            <span className={compact ? "sr-only" : undefined}>
                {link.label}
            </span>
        </a>
    );
}

function DownloadButton({
    documentId,
    versionId,
    filename,
    isReloading,
    compact,
    onDownload,
}: {
    documentId: string;
    versionId: string | null;
    filename: string;
    isReloading?: boolean;
    compact: boolean;
    onDownload?: () => Promise<void> | undefined;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleClick = async () => {
        if (busy || isReloading) return;
        setBusy(true);
        setError(null);
        try {
            const localDownload = onDownload?.();
            if (localDownload) {
                await localDownload;
                return;
            }
            const { blob, filename: resolvedFilename } = await getDocumentFile(
                documentId,
                versionId,
            );
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = resolvedFilename || filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } catch (cause) {
            setError(
                userFacingApiError(
                    cause,
                    "This file could not be downloaded. Please try again.",
                ),
            );
        } finally {
            setBusy(false);
        }
    };

    const spinning = busy || isReloading;
    return (
        <>
            <WarningPopup
                open={!!error}
                title="Download failed"
                message={error}
                onClose={() => setError(null)}
            />
            <TextButtonUI
                size={compact ? "icon-xs" : "sm"}
                onClick={handleClick}
                loading={!!spinning}
            >
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
                <span className={compact ? "sr-only" : undefined}>
                    Download
                </span>
            </TextButtonUI>
        </>
    );
}
