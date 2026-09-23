"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { SuperDocEditor, type SuperDocConfig, type SuperDocReadyEvent } from "@superdoc/react";
import "@superdoc/react/style.css";
import "./SuperdocDocxRenderer.css";
import type { DocxRendererProps } from "./DocxRenderer.types";

const telemetry = { enabled: false };
const workerUrls = {
    document: "/superdoc/0.16.0/document.js",
    collaboration: "/superdoc/0.16.0/collaboration.js",
    reviewIndex: "/superdoc/0.16.0/review-index.js",
};
const viewing: SuperDocConfig["viewing"] = { comments: true, trackedChanges: "markup" };
const zoom: SuperDocConfig["zoom"] = { mode: "fit-width", fitWidth: { min: 10, max: 100 } };
// Mike owns the View/Edit switch. Keep this configuration stable: changing UI
// props rebuilds the native editor and would discard the local document.
const ui: SuperDocConfig["ui"] = {
    toolbar: { excludeItems: ["document-mode"], responsiveTo: "container", overflow: "menu" },
    comments: { layout: "inline" },
    ruler: false,
};

export default function SuperdocDocxRenderer({ bytes, mode, filename, onChange, onSave, onReady, onError }: DocxRendererProps) {
    const host = useRef<HTMLDivElement>(null);
    const frame = useRef(0);
    const file = useMemo(() => new File([bytes], filename || "document.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }), [bytes, filename]);

    const ready = useCallback(({ superdoc }: SuperDocReadyEvent) => {
        frame.current = requestAnimationFrame(() => {
            const content = host.current?.querySelector<HTMLElement>(".superdoc-layout");
            const scroll = content?.closest<HTMLElement>(".superdoc__sub-document");
            if (!content || !scroll) return onError();
            onReady({
                content, scroll,
                exportDocx: async () => (await superdoc.export({ triggerDownload: false })).arrayBuffer(),
                revealText: (text) => {
                    // V2 search resolves off-screen matches in its worker and
                    // reveals the active result when that query settles.
                    return superdoc.ui.search.find(text).available;
                },
            });
        });
    }, [onReady, onError]);

    useEffect(() => () => cancelAnimationFrame(frame.current), []);

    return (
        <div ref={host} className="h-full min-h-0 min-w-0" data-docx-renderer="superdoc" data-docx-mode={mode}
            onKeyDownCapture={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    event.stopPropagation();
                    onSave?.();
                }
            }}>
            <SuperDocEditor document={file} documentMode={mode === "edit" ? "editing" : "viewing"}
                contained className="h-full min-h-0 min-w-0" ui={ui} zoom={zoom} viewing={viewing}
                telemetry={telemetry} workerUrls={workerUrls} allowSelectionInViewMode
                onReady={ready} onEditorUpdate={onChange} onCommentsUpdate={onChange}
                onContentError={onError} onException={onError} />
        </div>
    );
}
