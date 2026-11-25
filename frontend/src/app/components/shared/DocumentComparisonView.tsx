"use client";

import { Loader2 } from "lucide-react";
import { TextButtonUI } from "@mike/ui";
import type { OpenComparison } from "@/app/hooks/useDocumentComparison";
import { DocxView } from "./views/DocxView";

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
