"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ListTree } from "lucide-react";
import { DocxEditor } from "@docx-editor.dev/react";
import type { TextMatch } from "@docx-editor.dev/core";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import { packagedFonts } from "@docx-editor.dev/fonts";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { useOptionalAuth } from "@/app/contexts/AuthContext";
import { useOptionalUserProfile } from "@/app/contexts/UserProfileContext";
import { docxModules } from "@/app/lib/docxReviewModule";
import { DocxReviewPanel } from "./DocxReviewPanel";
import { findDocxQuote } from "./docxQuoteSelection";
import "@docx-editor.dev/core/styles/editor.css";
import styles from "./EigenpalDocxRenderer.module.css";
import type { DocxRendererProps } from "./DocxRenderer.types";

// Use packaged, metric-compatible fonts; document text never goes to a conversion service.
const fonts = packagedFonts();
const editorLabels = { formattingBar: { commentsAndChanges: "Comments" } };

export default function DocxRenderer({ bytes, mode, toolbarVisible = true, filename, author, onChange, onSave, onReady, onError }: DocxRendererProps) {
    const auth = useOptionalAuth();
    const profile = useOptionalUserProfile();
    const reviewAuthor = author?.trim() || profile?.profile?.displayName?.trim()
        || auth?.user?.email || auth?.user?.id;
    const host = useRef<HTMLDivElement>(null);
    const [reviewEditor, setReviewEditor] = useState<Editor | null>(null);
    const [reviewSurface, setReviewSurface] = useState<HTMLElement | null>(null);
    const [reviewRail, setReviewRail] = useState<HTMLElement | null>(null);
    const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
    const [navigationOpen, setNavigationOpen] = useState(false);
    const citationMatch = useRef<{ match: TextMatch; text: string } | null>(null);
    const unsubscribe = useRef<(() => void) | undefined>(undefined);
    const document = useMemo(() => new Uint8Array(bytes), [bytes]);
    useEffect(() => () => unsubscribe.current?.(), []);
    return (
        <div ref={host} className={`${styles.host} relative h-full min-h-0`} data-docx-renderer="eigenpal"
            data-toolbar-visible={toolbarVisible}
            onKeyDownCapture={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    event.stopPropagation();
                    void onSave?.();
                }
            }}>
            <DocxEditor
                document={document}
                i18n={editorLabels}
                fonts={fonts}
                mode={mode}
                modules={docxModules}
                author={reviewAuthor}
                chrome
                title={filename}
                onChange={onChange}
                onSave={onSave}
                menu={false}
                navigation={{ toggle: false, open: navigationOpen, onOpenChange: setNavigationOpen }}
                rulers={false}
                contextMenu
                className="h-full min-h-0 overflow-auto"
                zoomMode={{ type: "fit", fit: "pageWidth", minZoom: 0.1, maxZoom: 1 }}
                onFontError={onError}
                onReady={(editor) => {
                    // Preserve the unobstructed document view on open; the native
                    // Comments button controls Mike's comment panel.
                    if (editor.snapshot().reviewPaneOpen) editor.exec({ type: "toggleReviewPane" });
                    setReviewEditor(editor);
                    setToolbar(host.current?.querySelector<HTMLElement>(".docx-toolbar") ?? null);
                    unsubscribe.current?.();
                    unsubscribe.current = editor.on("error", onError);
                    if (editor.snapshot().parseError) {
                        onError();
                        return;
                    }
                    const content = host.current?.querySelector<HTMLElement>(".docx-paginated-surface");
                    setReviewSurface(content ?? null);
                    // The navigation pane and viewport share this flex row; the
                    // comment column docks at its end, mirroring the pane.
                    setReviewRail(host.current?.querySelector<HTMLElement>(".docx-nav")?.parentElement ?? null);
                    const scroll = host.current?.querySelector<HTMLElement>(".docx-editor__scroll-container");
                    if (content && scroll) onReady({
                        content, scroll, exportDocx: () => editor.save(),
                        revealRevision: (ids) => {
                            // The review model includes unpainted pages. Text search
                            // can land on identical wording earlier in the document.
                            const revision = editor.getReviewItems().find((item) =>
                                item.kind === "revision"
                                && item.item.ranges.some((range) => range.partName === "/word/document.xml")
                                && item.item.addresses.some((address) => ids.includes(address.id)),
                            );
                            if (revision?.kind !== "revision") return false;
                            const range = revision.item.ranges.find((entry) =>
                                entry.partName === "/word/document.xml",
                            );
                            return range ? editor.scrollToBlock(range.start.paragraphId) : false;
                        },
                        revealText: (text) => {
                            const match = editor.findMatches(text)[0];
                            return match ? editor.scrollToBlock(match.blockId) : false;
                        },
                        selectText: (text) => {
                            const match = findDocxQuote(editor, text);
                            if (!match || !editor.selectMatch(match.start).ok) return false;
                            if (match.end !== match.start) {
                                const result = editor.exec({ type: "setSelection", range: {
                                    anchor: { paragraphId: match.start.blockId, offset: match.start.start },
                                    head: { paragraphId: match.end.blockId, offset: match.end.start + match.end.length },
                                } });
                                if (!result.ok) {
                                    editor.selectMatch({ ...match.start, length: 0 });
                                    citationMatch.current = null;
                                    return false;
                                }
                                editor.scrollToBlock(match.start.blockId);
                            }
                            citationMatch.current = { match: match.start, text: editor.query({ type: "selectedText" }) };
                            return true;
                        },
                        clearTextSelection: () => {
                            const selection = citationMatch.current;
                            citationMatch.current = null;
                            // Leave a subsequent user selection alone. Collapse only
                            // the citation range that this viewer selected.
                            if (selection && editor.query({ type: "selectedText" }) === selection.text) {
                                editor.selectMatch({ ...selection.match, length: 0 });
                            }
                        },
                    });
                    else onError();
                }}
            >
                <DocxReviewPanel editor={reviewEditor} author={reviewAuthor} toolbar={toolbar} surface={reviewSurface} rail={reviewRail} />
            </DocxEditor>
            {toolbar && createPortal(
                // data-toolbar-fixed makes EigenPal reserve this width before
                // moving its own controls into More. Padding, not margin, so
                // the spacing is part of the measured width.
                <span data-toolbar-fixed="" className="order-last flex flex-none items-center pr-2">
                    <TextButtonUI
                        size="icon-xs"
                        aria-label="Document navigation"
                        title="Document navigation"
                        aria-expanded={navigationOpen}
                        className="h-6"
                        onClick={() => setNavigationOpen((open) => !open)}
                    >
                        <ListTree aria-hidden="true" className="h-4 w-4" />
                    </TextButtonUI>
                </span>,
                toolbar,
            )}
        </div>
    );
}
