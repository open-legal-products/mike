"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { useDocxAutosave } from "@/app/hooks/useDocxAutosave";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { DocxRenderBoundary } from "./DocxRenderBoundary";
import type { DocxMode, DocxSurface } from "./DocxRenderer.types";
import type { CitationQuote } from "../types";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { docxRevisionElements } from "./docxRevisionElements";

const DocxRenderer = lazy(() => import("./EigenpalDocxRenderer"));
const RENDER_ERROR = "This document could not be displayed. Please download it to view it.";
const bufferIds = new WeakMap<ArrayBuffer, number>();
let nextBufferId = 0;

// Keep the mounted renderer during a refresh; replace it only when new bytes arrive.
function bufferId(bytes: ArrayBuffer) {
    let id = bufferIds.get(bytes);
    if (id === undefined) {
        id = ++nextBufferId;
        bufferIds.set(bytes, id);
    }
    return id;
}

interface Props {
    documentId: string;
    /** Initial mode for each document; the reader can change it in the viewer. */
    defaultMode?: DocxMode;
    filename?: string;
    versionId?: string | null;
    displayUrl?: string | null;
    onReady?: () => void;
    onDownloadReady?: (download: (() => Promise<void>) | null) => void;
    highlightEdit?: {
        key: string;
        inserted_text?: string;
        deleted_text?: string;
        ins_w_id?: string | null;
        del_w_id?: string | null;
    } | null;
    refetchKey?: number | string;
    cacheBytes?: boolean;
    quotes?: CitationQuote[];
    quoteFocusKey?: string | number;
    warning?: string | null;
    onWarningDismiss?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
    rounded?: boolean;
}

function focusHighlights(surface: DocxSurface, props: Props, scrollToMatch = true): boolean {
    const { content, scroll } = surface;
    content.querySelectorAll(".docx-edit-flash").forEach((element) => element.classList.remove("docx-edit-flash"));
    const edit = props.highlightEdit;
    const revisions = edit ? [
        ...docxRevisionElements(content, "ins", edit.ins_w_id, edit.inserted_text),
        ...docxRevisionElements(content, "del", edit.del_w_id, edit.deleted_text),
    ] : [];
    revisions.forEach((element) => element.classList.add("docx-edit-flash"));
    // Repaints may restore revision flashes, but must not overwrite the user's
    // current selection. EigenPal owns citation selection and its painting.
    if (!scrollToMatch) return revisions.length > 0;
    const anchor = revisions[0];
    if (!anchor) {
        const text = edit?.inserted_text || edit?.deleted_text;
        if (text && surface.revealText?.(text)) {
            return true;
        }
        // Native selection holds one contiguous range. Select the first matching
        // quote segment, including when its page has not been painted yet.
        for (const quote of props.quotes ?? []) {
            for (const segment of quote.quote.split(/\[\[PAGE_BREAK\]\]|\.{3}|…/)) {
                const text = segment.trim();
                if (text && surface.selectText?.(text)) return true;
            }
        }
        surface.clearTextSelection?.();
        return false;
    }
    const offset = anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top
        + scroll.scrollTop - scroll.clientHeight / 2;
    scroll.scrollTo({ top: Math.max(0, offset), behavior: "instant" });
    return true;
}

/** DOCX view/edit surface shared by the assistant panel and project IDE. */
export function DocxView(props: Props) {
    // A different document/version must never briefly display the previous file.
    return <DocxViewContent key={JSON.stringify([props.documentId, props.versionId, props.displayUrl])} {...props} />;
}

function DocxViewContent(props: Props) {
    const {
        documentId, versionId, displayUrl, refetchKey, cacheBytes = true,
        warning, onWarningDismiss, onDownloadReady, rounded = true,
    } = props;
    const [initialMode] = useState<DocxMode>(props.defaultMode ?? "view");
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const fetched = useFetchDocxBytes(documentId, versionId, refetchKey, displayUrl, cacheBytes);
    // Metadata refreshes after an autosave must not remount the editor, lose
    // its undo stack, or discard edits typed while the upload was in flight.
    const [editedBytes, setEditedBytes] = useState<ArrayBuffer | null>(null);
    const bytes = editedBytes ?? fetched.bytes;
    const { loading } = fetched;
    const error = editedBytes ? null : fetched.error;
    const renderKey = bytes ? String(bufferId(bytes)) : null;
    const [readyKey, setReadyKey] = useState<string | null>(null);
    const [failedKey, setFailedKey] = useState<string | null>(null);
    const surfaceRef = useRef<DocxSurface | null>(null);
    const autosave = useDocxAutosave({
        documentId, versionId, filename: props.filename, bytes,
        enabled: !displayUrl,
        exportDocx: () => surfaceRef.current?.exportDocx?.(),
    });
    const { markChanged } = autosave;
    const lastScrollTop = useRef(props.initialScrollTop ?? 0);
    const propsRef = useRef(props);
    const scrollFrame = useRef(0);
    const focusFrame = useRef(0);

    useEffect(() => { propsRef.current = props; });
    useEffect(() => () => {
        cancelAnimationFrame(scrollFrame.current);
        cancelAnimationFrame(focusFrame.current);
    }, []);

    const focusSurface = useCallback((surface: DocxSurface) => {
        cancelAnimationFrame(focusFrame.current);
        const focused = focusHighlights(surface, propsRef.current);
        // Long jumps materialize pages and can trigger the engine's own scroll
        // restoration. Re-center once after that paint, using the current props.
        if (focused && propsRef.current.highlightEdit) focusFrame.current = requestAnimationFrame(() => {
            focusFrame.current = requestAnimationFrame(() => {
                if (surfaceRef.current === surface && surface.content.isConnected) {
                    focusHighlights(surface, propsRef.current);
                }
            });
        });
        return focused;
    }, []);

    const onReady = useCallback((surface: DocxSurface) => {
        const firstMount = surfaceRef.current?.content !== surface.content
            || surfaceRef.current?.scroll !== surface.scroll;
        surfaceRef.current = surface;
        setReadyKey(renderKey);
        setFailedKey(null);
        // Repeated ready notifications must not move the caret viewport
        // back to an earlier citation after an edit.
        if (!firstMount) return;
        if (!focusSurface(surface)) {
            surface.scroll.scrollTop = lastScrollTop.current;
        }
        propsRef.current.onReady?.();
    }, [renderKey, focusSurface]);
    const onError = useCallback(() => setFailedKey(renderKey), [renderKey]);
    const onChange = useCallback(() => {
        if (!surfaceRef.current?.content.isConnected) return;
        setEditedBytes(bytes);
        markChanged();
    }, [bytes, markChanged]);
    const download = useCallback(async (providedBytes?: ArrayBuffer) => {
        const surface = surfaceRef.current;
        if (!surface?.exportDocx || downloading) return;
        setDownloading(true);
        setDownloadError(null);
        try {
            const buffer = providedBytes ?? await surface.exportDocx();
            const url = URL.createObjectURL(new Blob([buffer], {
                type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }));
            const link = document.createElement("a");
            link.href = url;
            const name = propsRef.current.filename || "document.docx";
            link.download = /\.docx$/i.test(name) ? name : `${name}.docx`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {
            setDownloadError("This document could not be downloaded. Your edits are still open; please try again.");
        } finally {
            setDownloading(false);
        }
    }, [downloading]);
    useEffect(() => {
        if (readyKey !== renderKey || failedKey === renderKey) return;
        onDownloadReady?.(download);
        return () => onDownloadReady?.(null);
    }, [onDownloadReady, readyKey, renderKey, failedKey, download]);
    const quoteKey = JSON.stringify(props.quotes ?? []);
    useEffect(() => {
        if (surfaceRef.current && readyKey === renderKey && bytes) {
            focusSurface(surfaceRef.current);
        }
    }, [bytes, readyKey, renderKey, quoteKey, props.quoteFocusKey, props.highlightEdit?.key, focusSurface]);

    // Font loading, fitting and page virtualization can replace the engine's
    // painted runs. Restore revision flashes without changing native selection.
    useEffect(() => {
        const surface = surfaceRef.current;
        if (!surface || readyKey !== renderKey) return;
        let frame = 0;
        const observer = new MutationObserver((records) => {
            const repainted = records.some((record) => Array.from(record.addedNodes).some(
                (node) => node instanceof Element && (
                    node.matches(".docx-page")
                    || node.querySelector(".docx-page")
                ),
            ));
            if (!repainted) return;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => focusHighlights(surface, propsRef.current, false));
        });
        observer.observe(surface.content, { childList: true, subtree: true });
        return () => { observer.disconnect(); cancelAnimationFrame(frame); };
    }, [readyKey, renderKey]);

    const renderError = bytes && failedKey === renderKey ? RENDER_ERROR : null;
    const message = error || renderError;
    const pending = !message && (loading && !bytes || bytes && readyKey !== renderKey);
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <WarningPopup open={!!downloadError} title="Download failed" message={downloadError} onClose={() => setDownloadError(null)} />
            <div
                className={`document-canvas relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${rounded ? "rounded-lg" : ""}`}
                data-document-id={documentId}
                data-version-id={versionId ?? ""}
                onScrollCapture={(event) => {
                    const surface = surfaceRef.current;
                    if (!surface || event.target !== surface.scroll) return;
                    lastScrollTop.current = surface.scroll.scrollTop;
                    cancelAnimationFrame(scrollFrame.current);
                    scrollFrame.current = requestAnimationFrame(() => {
                        propsRef.current.onScrollChange?.(lastScrollTop.current);
                    });
                }}
            >
                {warning && (
                    <div className="absolute left-2 top-2 z-20 flex items-center gap-2 rounded-md bg-app-floating px-2 py-1 text-xs text-foreground shadow-sm">
                        <span>{warning}</span>
                        <button type="button" onClick={onWarningDismiss} aria-label="Dismiss warning"
                            className="rounded px-1 focus-visible:outline-2 focus-visible:outline-ring">×</button>
                    </div>
                )}
                {pending && (
                    <div role="status" aria-label="Loading document" className="absolute inset-0 z-10 flex items-center justify-center bg-app-surface">
                        <Loader2 aria-hidden="true" className="h-7 w-7 animate-spin text-muted-foreground" />
                    </div>
                )}
                {message && <div role="alert" className="flex h-full items-center justify-center p-5 text-sm text-destructive">{message}</div>}
                <div className="docx-view-container min-h-0 flex-1" hidden={!!message}>
                    {bytes && (
                        <DocxRenderBoundary key={renderKey} onError={onError}>
                            <Suspense fallback={null}>
                                <DocxRenderer bytes={bytes} mode={initialMode} filename={props.filename} onChange={onChange} onSave={displayUrl ? download : autosave.save} onReady={onReady} onError={onError} />
                            </Suspense>
                        </DocxRenderBoundary>
                    )}
                </div>
                {!displayUrl && !message && readyKey === renderKey && bytes && (
                    <div className="flex shrink-0 items-center justify-end gap-2 bg-app-surface px-3 py-1 text-xs text-muted-foreground">
                        <span role="status" aria-live="polite" className={autosave.error ? "text-destructive" : undefined}>
                            {autosave.error ?? (autosave.status === "saving" ? "Saving…" : autosave.dirty ? "Unsaved changes" : autosave.status === "saved" ? "Saved" : "Autosave on")}
                        </span>
                        {autosave.dirty && autosave.status !== "saving" && (
                            <PillButtonUI tone="white" size="xs" onClick={() => void autosave.save()}>
                                {autosave.error ? "Retry save" : "Save now"}
                            </PillButtonUI>
                        )}
                        {autosave.error && (
                            <PillButtonUI tone="white" size="xs" onClick={() => void download()}>Download copy</PillButtonUI>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
