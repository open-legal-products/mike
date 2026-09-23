"use client";

import { useCallback, useEffect, useRef } from "react";
import { DocxEditor, type DocxEditorRef, type RenderedDomContext } from "@casualoffice/docs";
import "@casualoffice/docs/styles.css";
import "./CasualDocxRenderer.css";
import type { DocxRendererProps } from "./DocxRenderer.types";

export default function DocxRenderer({ bytes, onReady, onError }: DocxRendererProps) {
    const host = useRef<HTMLDivElement>(null);
    const editor = useRef<DocxEditorRef>(null);
    const pages = useRef<HTMLElement | null>(null);
    const frame = useRef(0);

    const fit = useCallback(() => {
        const page = pages.current?.querySelector<HTMLElement>(".layout-page");
        if (!host.current || !page || !page.offsetWidth) return;
        // The editor reserves an unscaled 1168px for its review sidebar. In a
        // preview we show redlines on the page, without that editing sidebar.
        const stack = pages.current?.parentElement;
        stack?.classList.add("mike-casual-page-stack");
        let ancestor = stack?.parentElement;
        while (ancestor && ancestor !== host.current) {
            if (parseFloat(ancestor.style.minWidth) > 0) ancestor.classList.add("mike-casual-preview-width");
            ancestor = ancestor.parentElement;
        }
        const zoom = Math.min(1, Math.max(0.1, (host.current.clientWidth - 32) / (page.offsetWidth + 48)));
        host.current.style.setProperty("--mike-docx-preview-zoom", String(zoom));
        if (Math.abs((editor.current?.getZoom() ?? 1) - zoom) > 0.005) editor.current?.setZoom(zoom);
    }, []);

    const publish = useCallback(() => {
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
            const content = pages.current;
            if (!content?.querySelector(".layout-page")) return;
            fit();
            let scroll = content.parentElement;
            while (scroll && scroll !== host.current && !/auto|scroll/.test(getComputedStyle(scroll).overflowY)) {
                scroll = scroll.parentElement;
            }
            if (scroll) {
                scroll.style.overflowAnchor = "none";
                onReady({ content, scroll });
            }
        });
    }, [fit, onReady]);

    // Casual includes this callback in its layout pipeline dependencies. Keep
    // its identity stable when Mike changes only a citation or edit highlight.
    const onRendered = useCallback((context: RenderedDomContext) => {
        pages.current = context.pagesContainer;
        publish();
    }, [publish]);

    useEffect(() => {
        const observer = new ResizeObserver(fit);
        if (host.current) observer.observe(host.current);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame.current);
        };
    }, [fit]);

    return (
        <div ref={host} className="h-full min-h-0" data-docx-renderer="casual">
            <DocxEditor
                ref={editor}
                documentBuffer={bytes}
                readOnly
                mode="viewing"
                chrome="none"
                showRuler={false}
                showZoomControl={false}
                onError={onError}
                onFontsLoaded={publish}
                onReady={publish}
                onRenderedDomContextReady={onRendered}
            />
        </div>
    );
}
