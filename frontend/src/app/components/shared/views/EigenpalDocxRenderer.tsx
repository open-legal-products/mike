"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { DocxEditor } from "@docx-editor.dev/react";
import type { TextMatch } from "@docx-editor.dev/core";
import { packagedFonts } from "@docx-editor.dev/fonts";
import { LIQUID_GLASS_TRANSLUCENT_CLASS } from "@/shared/ui/LiquidGlassUI";
import "@docx-editor.dev/core/styles/editor.css";
import styles from "./EigenpalDocxRenderer.module.css";
import type { DocxRendererProps } from "./DocxRenderer.types";

// Use packaged, metric-compatible fonts; document text never goes to a conversion service.
const fonts = packagedFonts();

export default function DocxRenderer({ bytes, mode, filename, onChange, onSave, onReady, onError }: DocxRendererProps) {
    const host = useRef<HTMLDivElement>(null);
    const citationMatch = useRef<TextMatch | null>(null);
    const unsubscribe = useRef<(() => void) | undefined>(undefined);
    const document = useMemo(() => new Uint8Array(bytes), [bytes]);
    useEffect(() => () => unsubscribe.current?.(), []);
    useLayoutEffect(() => {
        const root = host.current;
        const header = root?.querySelector(".docx-toolbar")?.parentElement?.parentElement;
        if (!root || !header) return;
        const measure = () => root.style.setProperty("--mike-docx-toolbar-height", `${header.getBoundingClientRect().height}px`);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(header);
        return () => observer.disconnect();
    }, []);
    return (
        <div ref={host} className={`${styles.host} h-full min-h-0`} data-docx-renderer="eigenpal"
            onKeyDownCapture={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    event.stopPropagation();
                    void onSave?.();
                }
            }}>
            <DocxEditor
                document={document}
                fonts={fonts}
                mode={mode}
                chrome
                title={filename}
                onChange={onChange}
                onSave={onSave}
                menu={false}
                navigation={{ toggle: { className: `${styles.navigationToggle} ${LIQUID_GLASS_TRANSLUCENT_CLASS}` } }}
                rulers={false}
                contextMenu
                className="h-full min-h-0 overflow-auto"
                zoomMode={{ type: "fit", fit: "pageWidth", minZoom: 0.1, maxZoom: 1 }}
                onFontError={onError}
                onReady={(editor) => {
                    unsubscribe.current?.();
                    unsubscribe.current = editor.on("error", onError);
                    if (editor.snapshot().parseError) {
                        onError();
                        return;
                    }
                    const content = host.current?.querySelector<HTMLElement>(".docx-paginated-surface");
                    const scroll = host.current?.querySelector<HTMLElement>(".docx-editor__scroll-container");
                    if (content && scroll) onReady({
                        content, scroll, exportDocx: () => editor.save(),
                        revealText: (text) => {
                            const match = editor.findMatches(text)[0];
                            return match ? editor.scrollToBlock(match.blockId) : false;
                        },
                        selectText: (text) => {
                            const match = editor.findMatches(text)[0];
                            if (!match || !editor.selectMatch(match).ok) return false;
                            citationMatch.current = match;
                            return true;
                        },
                        clearTextSelection: () => {
                            const match = citationMatch.current;
                            citationMatch.current = null;
                            // Leave a subsequent user selection alone. Collapse only
                            // the citation range that this viewer selected.
                            if (match && editor.query({ type: "selectedText" }) === match.text) {
                                editor.selectMatch({ ...match, length: 0 });
                            }
                        },
                    });
                    else onError();
                }}
            />
        </div>
    );
}
