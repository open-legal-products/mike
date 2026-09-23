"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { clearDocxQuoteHighlights, highlightDocxQuote } from "./highlightDocxQuote";
import { DocxRenderBoundary } from "./DocxRenderBoundary";
import type { DocxSurface } from "./DocxRenderer.types";
import type { CitationQuote } from "../types";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
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

/** Read-only DOCX preview shared by the assistant panel and project IDE. */
export function DocxView(props: Props) {
    const [engine, setEngine] = useState<Engine>("eigenpal");
    // A different document/version must never briefly display the previous file.
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div role="group" aria-label="DOCX rendering engine" className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
                <span className="text-xs text-muted-foreground">Renderer</span>
                <TabPillButtonUI active={engine === "eigenpal"} onClick={() => setEngine("eigenpal")}>EigenPal</TabPillButtonUI>
                <TabPillButtonUI active={engine === "casual"} onClick={() => setEngine("casual")}>Casual Docs</TabPillButtonUI>
                {engine === "eigenpal" && <span className="text-xs text-muted-foreground">Deleted text is hidden. Use Casual Docs to view redlines.</span>}
            </div>
            <DocxViewContent key={JSON.stringify([props.documentId, props.versionId, props.displayUrl])} {...props} engine={engine} />
        </div>
    );
}

function DocxViewContent(props: Props & { engine: Engine }) {
    const {
        documentId, versionId, displayUrl, refetchKey, cacheBytes = true,
        warning, onWarningDismiss, rounded = true,
    } = props;
    const { bytes, loading, error } = useFetchDocxBytes(documentId, versionId, refetchKey, displayUrl, cacheBytes);
    const renderKey = bytes ? props.engine + bufferId(bytes) : null;
    const [readyKey, setReadyKey] = useState<string | null>(null);
    const [failedKey, setFailedKey] = useState<string | null>(null);
    const DocxRenderer = props.engine === "eigenpal" ? EigenpalDocxRenderer : CasualDocxRenderer;
    const surfaceRef = useRef<DocxSurface | null>(null);
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
        surfaceRef.current = surface;
        setReadyKey(renderKey);
        setFailedKey(null);
        if (!focusSurface(surface)) {
            surface.scroll.scrollTop = lastScrollTop.current;
        }
        propsRef.current.onReady?.();
    }, [renderKey, focusSurface]);
    const onError = useCallback(() => setFailedKey(renderKey), [renderKey]);
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
    return (
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
                            <DocxRenderer bytes={bytes} onReady={onReady} onError={onError} />
                        </Suspense>
                    </DocxRenderBoundary>
                )}
            </div>
        </div>
    );
}
