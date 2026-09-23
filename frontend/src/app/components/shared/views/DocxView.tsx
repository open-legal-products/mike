"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { clearDocxQuoteHighlights, highlightDocxQuote } from "./highlightDocxQuote";
import { DocxRenderBoundary } from "./DocxRenderBoundary";
import type { DocxMode, DocxSurface } from "./DocxRenderer.types";
import type { CitationQuote } from "../types";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { docxRevisionElements } from "./docxRevisionElements";

const EigenpalDocxRenderer = lazy(() => import("./EigenpalDocxRenderer"));
const CasualDocxRenderer = lazy(() => import("./CasualDocxRenderer"));
type Engine = "eigenpal" | "casual";
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
    mode?: DocxMode;
    filename?: string;
    versionId?: string | null;
    displayUrl?: string | null;
    onReady?: () => void;
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
    clearDocxQuoteHighlights(content);
    content.querySelectorAll(".docx-edit-flash").forEach((element) => element.classList.remove("docx-edit-flash"));
    let quoteAnchor: HTMLElement | null = null;
    for (const quote of props.quotes ?? []) {
        const match = highlightDocxQuote(content, quote.quote, false);
        quoteAnchor ??= match;
    }
    const edit = props.highlightEdit;
    const revisions = edit ? [
        ...docxRevisionElements(content, "ins", edit.ins_w_id, edit.inserted_text),
        ...docxRevisionElements(content, "del", edit.del_w_id, edit.deleted_text),
    ] : [];
    revisions.forEach((element) => element.classList.add("docx-edit-flash"));
    const anchor = revisions[0] || quoteAnchor;
    if (!anchor) {
        const text = edit?.inserted_text || edit?.deleted_text || props.quotes?.[0]?.quote.split(/\[\[PAGE_BREAK\]\]|\.{3}|…/)[0]?.trim();
        if (scrollToMatch && text && surface.revealText?.(text)) {
            return true;
        }
        return false;
    }
    if (!scrollToMatch) return true;
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
        warning, onWarningDismiss, rounded = true,
    } = props;
    const [engine, setEngine] = useState<Engine>("eigenpal");
    const [pendingEngine, setPendingEngine] = useState<Engine | null>(null);
    const [dirtyKey, setDirtyKey] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const editSequence = useRef(0);
    const { bytes, loading, error } = useFetchDocxBytes(documentId, versionId, refetchKey, displayUrl, cacheBytes);
    const renderKey = bytes ? engine + bufferId(bytes) : null;
    const dirty = dirtyKey !== null && dirtyKey === renderKey;
    const [readyKey, setReadyKey] = useState<string | null>(null);
    const [failedKey, setFailedKey] = useState<string | null>(null);
    const DocxRenderer = engine === "eigenpal" ? EigenpalDocxRenderer : CasualDocxRenderer;
    const surfaceRef = useRef<DocxSurface | null>(null);
    const lastScrollTop = useRef(props.initialScrollTop ?? 0);
    const propsRef = useRef(props);
    const scrollFrame = useRef(0);
    const focusFrame = useRef(0);

    useEffect(() => { propsRef.current = props; });
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    useEffect(() => () => {
        cancelAnimationFrame(scrollFrame.current);
        cancelAnimationFrame(focusFrame.current);
    }, []);

    const focusSurface = useCallback((surface: DocxSurface) => {
        cancelAnimationFrame(focusFrame.current);
        const focused = focusHighlights(surface, propsRef.current);
        // Long jumps materialize pages and can trigger the engine's own scroll
        // restoration. Re-center once after that paint, using the current props.
        if (focused) focusFrame.current = requestAnimationFrame(() => {
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
        // Casual republishes its DOM after edits; don't move the caret's
        // viewport back to an earlier citation on every keystroke.
        if (!firstMount) return;
        if (!focusSurface(surface)) {
            surface.scroll.scrollTop = lastScrollTop.current;
        }
        propsRef.current.onReady?.();
    }, [renderKey, focusSurface]);
    const onError = useCallback(() => setFailedKey(renderKey), [renderKey]);
    const onChange = useCallback(() => {
        if (!surfaceRef.current?.content.isConnected) return;
        editSequence.current += 1;
        setDirtyKey(renderKey);
    }, [renderKey]);
    const download = useCallback(async (providedBytes?: ArrayBuffer) => {
        const surface = surfaceRef.current;
        if (!surface?.exportDocx || downloading) return;
        const sequence = editSequence.current;
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
            if (editSequence.current === sequence) setDirtyKey(null);
        } catch {
            setDownloadError("This document could not be downloaded. Your edits are still open; please try again.");
        } finally {
            setDownloading(false);
        }
    }, [downloading]);
    const quoteKey = JSON.stringify(props.quotes ?? []);
    useEffect(() => {
        if (surfaceRef.current && readyKey === renderKey && bytes) {
            focusSurface(surfaceRef.current);
        }
    }, [bytes, readyKey, renderKey, quoteKey, props.quoteFocusKey, props.highlightEdit?.key, focusSurface]);

    // Font loading, fitting and page virtualization can replace the engine's
    // painted runs. Restore highlights without pulling the reader's scroll back.
    useEffect(() => {
        const surface = surfaceRef.current;
        if (!surface || readyKey !== renderKey) return;
        let frame = 0;
        const observer = new MutationObserver((records) => {
            const repainted = records.some((record) => Array.from(record.addedNodes).some(
                (node) => node instanceof Element && (
                    node.matches(".docx-page, .layout-page, .layout-line")
                    || node.querySelector(".layout-line")
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
    const switchEngine = (next: Engine) => {
        if (engine === next) return;
        if (dirty) setPendingEngine(next);
        else setEngine(next);
    };
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div role="group" aria-label="DOCX rendering engine" className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
                <span className="text-xs text-muted-foreground">Renderer</span>
                <TabPillButtonUI active={engine === "eigenpal"} disabled={downloading} onClick={() => switchEngine("eigenpal")}>EigenPal</TabPillButtonUI>
                <TabPillButtonUI active={engine === "casual"} disabled={downloading} onClick={() => switchEngine("casual")}>Casual Docs</TabPillButtonUI>
                {(props.mode === "edit" || dirty) && <PillButtonUI tone="white" size="sm" disabled={!!pending || !!message || downloading} onClick={() => void download()}>Download DOCX</PillButtonUI>}
                {engine === "eigenpal" && <span className="text-xs text-muted-foreground">Deleted text is hidden. Use Casual Docs to view redlines.</span>}
                {(props.mode === "edit" || dirty) && <span className="text-xs text-muted-foreground">{dirty ? "Unsaved local edits. " : ""}Download to keep edits before closing or switching documents.</span>}
                {downloadError && <span role="alert" className="text-xs text-destructive">{downloadError}</span>}
            </div>
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
                                <DocxRenderer bytes={bytes} mode={props.mode ?? "view"} filename={props.filename} onChange={onChange} onSave={download} onReady={onReady} onError={onError} />
                            </Suspense>
                        </DocxRenderBoundary>
                    )}
                </div>
            </div>
            <ConfirmPopup open={pendingEngine !== null} title="Discard local edits?"
                message="Switching renderers reloads the original document. Download your edited DOCX first to keep it."
                confirmLabel="Discard and switch" cancelLabel="Keep editing" confirmVariant="danger"
                onCancel={() => setPendingEngine(null)} onConfirm={() => {
                    if (pendingEngine) setEngine(pendingEngine);
                    setDirtyKey(null);
                    setPendingEngine(null);
                }} />
        </div>
    );
}
