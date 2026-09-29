import type { ReactNode } from "react";

/** Shared panel header above the viewer toolbar. The annotation (citation
 * quotes or a tracked change) is never clipped here: its quoted or changed
 * text scrolls within the card past a fixed height, keeping the card's
 * actions and the document canvas in view. */
export function DocumentAnnotationLayer({
    children,
    title,
    annotation,
}: {
    children: ReactNode;
    title?: ReactNode;
    annotation?: ReactNode;
}) {
    return (
        <div
            data-document-annotation-host
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
            <div
                data-document-panel-header
                className="flex shrink-0 flex-col"
            >
                {title}
                {annotation && (
                    <div role="region" aria-label="Document annotation">
                        {annotation}
                    </div>
                )}
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                {children}
            </div>
        </div>
    );
}
