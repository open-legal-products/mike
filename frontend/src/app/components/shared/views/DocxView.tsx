"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { useDocxAutosave } from "@/app/hooks/useDocxAutosave";
import { DocxRenderBoundary } from "./DocxRenderBoundary";
import { DocxSaveErrorPopup } from "./DocxSaveErrorPopup";
import { downloadBlob } from "@/app/lib/downloadDocument";
import type { DocxCloseGuard, DocxMode, DocxSaveState, DocxSurface } from "./DocxRenderer.types";
import type { CitationQuote } from "../types";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { viewRoundingClass, type ViewRounding } from "./viewRounding";

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
    canEdit?: boolean;
    toolbarVisible?: boolean;
    filename?: string;
    /** Explicit author for standalone previews; app viewers use the signed-in profile. */
    author?: string;
    versionId?: string | null;
    displayUrl?: string | null;
    onReady?: () => void;
    onCloseGuardReady?: (guard: DocxCloseGuard | null) => void;
    onDownloadReady?: (download: (() => Promise<void>) | null) => void;
    onSaveStateChange?: (documentId: string, state: DocxSaveState | null) => void;
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
    rounded?: ViewRounding;
}

function focusHighlights(surface: DocxSurface, props: Props): boolean {
    const edit = props.highlightEdit;
    if (edit && (edit.ins_w_id != null || edit.del_w_id != null)
        && surface.activateRevision?.({ ins: edit.ins_w_id, del: edit.del_w_id })) return true;
    surface.clearRevisionHighlight?.();
    const text = edit?.inserted_text || edit?.deleted_text;
    if (text && surface.selectText?.(text)) return true;
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

/** DOCX view/edit surface shared by the assistant panel and project IDE. */
export function DocxView(props: Props) {
    // A different document/version must never briefly display the previous file.
    return <DocxViewContent key={JSON.stringify([props.documentId, props.versionId, props.displayUrl])} {...props} />;
}

function DocxViewContent(props: Props) {
    const {
        documentId, versionId, displayUrl, refetchKey, cacheBytes = true,
        warning, onWarningDismiss, onDownloadReady, onSaveStateChange, rounded = true,
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
        enabled: props.canEdit !== false && !displayUrl,
        exportDocx: () => surfaceRef.current?.exportDocx?.(),
    });
    const { markChanged, adoptSnapshot, captureSnapshotRevision } = autosave;
    const fetchRevision = useRef(0);
    useEffect(() => {
        // Match the fetch hook's request identity. A read that spans a local
        // change/save cannot replace the editor with an earlier server snapshot.
        fetchRevision.current = captureSnapshotRevision();
    }, [documentId, versionId, refetchKey, displayUrl, cacheBytes, captureSnapshotRevision]);
    const seenFetchedBytes = useRef(fetched.bytes);
    useEffect(() => {
        if (seenFetchedBytes.current === fetched.bytes) return;
        seenFetchedBytes.current = fetched.bytes;
        if (editedBytes && fetched.bytes && adoptSnapshot(fetched.bytes, fetchRevision.current)) {
            // Reset the save baseline and replace the clean editor together.
            setEditedBytes(fetched.bytes);
        }
    }, [fetched.bytes, editedBytes, adoptSnapshot]);
    const { dirty, status, error: saveError, hasUnsavedChanges, prepareClose, discard } = autosave;
    useEffect(() => {
        props.onCloseGuardReady?.({ hasUnsavedChanges, prepareClose, discard });
        return () => props.onCloseGuardReady?.(null);
    }, [props.onCloseGuardReady, hasUnsavedChanges, prepareClose, discard]);
    const saveReady = !!bytes && !error && !displayUrl && readyKey === renderKey && failedKey !== renderKey;
    useEffect(() => {
        onSaveStateChange?.(documentId, { ready: saveReady, dirty, status, error: saveError });
    }, [onSaveStateChange, documentId, saveReady, dirty, status, saveError]);
    useEffect(() => () => onSaveStateChange?.(documentId, null), [onSaveStateChange, documentId]);
    const lastScrollTop = useRef(props.initialScrollTop ?? 0);
    const propsRef = useRef(props);
    const scrollFrame = useRef(0);

    useEffect(() => { propsRef.current = props; });
    useEffect(() => () => {
        cancelAnimationFrame(scrollFrame.current);
    }, []);

    const focusSurface = useCallback((surface: DocxSurface) =>
        focusHighlights(surface, propsRef.current), []);

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
        if (props.canEdit === false || !surfaceRef.current?.content.isConnected) return;
        setEditedBytes(bytes);
        markChanged();
    }, [bytes, markChanged, props.canEdit]);
    const download = useCallback(async (providedBytes?: ArrayBuffer) => {
        const surface = surfaceRef.current;
        if (!surface?.exportDocx || downloading) return;
        setDownloading(true);
        setDownloadError(null);
        try {
            const buffer = providedBytes ?? await surface.exportDocx();
            const name = propsRef.current.filename || "document.docx";
            downloadBlob(new Blob([buffer], {
                type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }), /\.docx$/i.test(name) ? name : `${name}.docx`);
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

    const renderError = bytes && failedKey === renderKey ? RENDER_ERROR : null;
    const message = error || renderError;
    const pending = !message && (loading && !bytes || bytes && readyKey !== renderKey);
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <WarningPopup open={!!downloadError} title="Download failed" message={downloadError} onClose={() => setDownloadError(null)} />
            <div
                className={`document-canvas relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${viewRoundingClass(rounded)}`}
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
                            className="rounded px-1 focus-visible:outline-2 focus-visible:outline-blue-500/40">×</button>
                    </div>
                )}
                {pending && (
                    <div role="status" aria-label="Loading document" className="absolute inset-0 z-10 flex items-center justify-center bg-app-surface">
                        <Loader2 aria-hidden="true" className="h-7 w-7 animate-spin text-muted-foreground" />
                    </div>
                )}
                {message && <div role="alert" className="flex h-full items-center justify-center p-5 text-sm text-destructive">{message}</div>}
                {!onSaveStateChange && <DocxSaveErrorPopup error={saveError} />}
                <div className="docx-view-container min-h-0 flex-1" hidden={!!message}>
                    {bytes && (
                        <DocxRenderBoundary key={renderKey} onError={onError}>
                            <Suspense fallback={null}>
                                <DocxRenderer bytes={bytes} mode={initialMode} toolbarVisible={props.canEdit === false ? false : props.toolbarVisible} filename={props.filename} author={props.author} onChange={onChange} onSave={displayUrl ? download : autosave.save} onReady={onReady} onError={onError} />
                            </Suspense>
                        </DocxRenderBoundary>
                    )}
                </div>
            </div>
        </div>
    );
}
