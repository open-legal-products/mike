"use client";

import type { ReactNode } from "react";
import { ArrowRight, Download, GitCompareArrows, Loader2 } from "lucide-react";
import { CloseButton, PillButtonUI, TextButtonUI } from "@mike/ui";
import type { OpenComparison } from "@/app/hooks/useDocumentComparison";
import { DocumentPaneTitle } from "./DocumentPaneTitle";
import { versionLabel, type VersionComparison } from "./versionComparison";
import { DocxView } from "./views/DocxView";

export function DocumentComparisonTitle({ filename, pair, targetPicker, onDownload, onClose }: {
    filename: string;
    pair: VersionComparison;
    targetPicker?: ReactNode;
    onDownload?: () => void;
    onClose: () => void;
}) {
    return (
        <div role="group" aria-label="Document comparison" className="shrink-0">
            <div className="flex items-center gap-2 pr-3">
                <div className="min-w-0 flex-1">
                    <DocumentPaneTitle filename={filename} fileType="docx" />
                </div>
                <PillButtonUI tone="white" size="sm" onClick={onDownload}
                    disabled={!onDownload} aria-label="Download comparison" title="Download comparison">
                    <Download aria-hidden="true" className="size-3.5" />
                    Download
                </PillButtonUI>
                <CloseButton size="md" label="Close comparison" onClick={onClose} />
            </div>
            <div className="-mt-1 flex flex-wrap items-center gap-1.5 px-3 pb-2 text-xs text-muted-foreground">
                <GitCompareArrows aria-hidden="true" className="size-3.5" />
                Redline
                <span>{versionLabel(pair.base)}</span>
                <ArrowRight aria-hidden="true" className="size-3" />
                <span className="sr-only">to</span>
                {targetPicker ?? <span>{versionLabel(pair.target)}</span>}
            </div>
        </div>
    );
}

export function DocumentComparisonView({ documentId, comparison, onRetry }: {
    documentId: string;
    comparison: OpenComparison;
    onRetry: () => void;
}) {
    const { bytes, error, filename, download } = comparison;
    if (bytes) {
        return <DocxView documentId={documentId} filename={filename} readOnlyFile={{ bytes, download }}
            canEdit={false} rounded={false} />;
    }
    if (error) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-sm">
                <p role="alert">{error.message}</p>
                {error.retryable && <TextButtonUI onClick={onRetry}>Retry comparison</TextButtonUI>}
            </div>
        );
    }
    return (
        <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Comparing versions…
        </div>
    );
}
