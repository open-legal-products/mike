"use client";

import { useEffect, useMemo, useRef } from "react";
import { DocxEditor } from "@docx-editor.dev/react";
import { packagedFonts } from "@docx-editor.dev/fonts";
import "@docx-editor.dev/core/styles/editor.css";
import type { DocxRendererProps } from "./DocxRenderer.types";

// Use packaged, metric-compatible fonts; document text never goes to a conversion service.
const fonts = packagedFonts();

export default function DocxRenderer({ bytes, mode, filename, onChange, onSave, onReady, onError }: DocxRendererProps) {
    const host = useRef<HTMLDivElement>(null);
    const unsubscribe = useRef<(() => void) | undefined>(undefined);
    const document = useMemo(() => new Uint8Array(bytes), [bytes]);
    useEffect(() => () => unsubscribe.current?.(), []);
    return (
        <div ref={host} className="h-full min-h-0" data-docx-renderer="eigenpal">
            <DocxEditor
                document={document}
                fonts={fonts}
                mode={mode}
                chrome
                title={filename}
                onChange={onChange}
                onSave={onSave}
                menu={false}
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
                    if (content && scroll) onReady({ content, scroll, exportDocx: () => editor.save(), revealText: (text) => {
                        const match = editor.findMatches(text)[0];
                        if (!match) return false;
                        editor.selectMatch(match);
                        return true;
                    } });
                    else onError();
                }}
            />
        </div>
    );
}
