import type { ReactNode } from "react";

/** Shared panel header above the viewer toolbar. Long annotations scroll within
 * the header, leaving the document canvas available beneath them. */
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
                className="flex max-h-[40%] shrink-0 flex-col"
            >
                {title}
                {annotation && (
                    <div
                        role="region"
                        aria-label="Document annotation"
                        className="min-h-0 overflow-y-auto overscroll-contain"
                    >
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
