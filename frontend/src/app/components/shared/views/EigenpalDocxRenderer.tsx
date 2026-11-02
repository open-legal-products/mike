"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { DocxEditor } from "@docx-editor.dev/react";
import type { TextMatch } from "@docx-editor.dev/core";
import type { Editor, ReviewPosition, ReviewRevisionPlacement } from "@docx-editor.dev/core/contracts/editor";
import { packagedFonts } from "@docx-editor.dev/fonts";
import { useOptionalAuth } from "@/app/contexts/AuthContext";
import { useOptionalUserProfile } from "@/app/contexts/UserProfileContext";
import { docxModules } from "@/app/lib/docxReviewModule";
import { DocxReviewPanel } from "./DocxReviewPanel";
import { DocxNavigationMenu } from "./DocxNavigationMenu";
import { findDocxQuote } from "./docxQuoteSelection";
import "@docx-editor.dev/core/styles/editor.css";
import styles from "./EigenpalDocxRenderer.module.css";
import type { DocxRendererProps } from "./DocxRenderer.types";

// Use packaged, metric-compatible fonts; document text never goes to a conversion service.
const fonts = packagedFonts();
const editorLabels = { formattingBar: { commentsAndChanges: "Comments" } };
const BODY_PART = "/word/document.xml";

/**
 * The ranges of a native review item that belong to one Mike edit. A native
 * replacement can pair this edit with a neighbouring revision; its leading
 * `replacedRangeCount` ranges are the deletion and the rest the insertion.
 */
function editRanges(revision: ReviewRevisionPlacement, ins?: string | null, del?: string | null) {
    const { item } = revision;
    const split = item.replacedRangeCount;
    const owns = (id?: string | null) => id != null && item.addresses.some((address) => address.id === id);
    if (item.revisionKind !== "replace" || split == null || (owns(ins) && owns(del))) return item.ranges;
    return owns(del) ? item.ranges.slice(0, split) : item.ranges.slice(split);
}

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
    const [fontWarning, setFontWarning] = useState(false);
    const activeRevision = useRef<string | null>(null);
    const revisionSelection = useRef<{ anchor: ReviewPosition; text: string } | null>(null);
    const citationMatch = useRef<{ match: TextMatch; text: string } | null>(null);
    const unsubscribe = useRef<(() => void) | undefined>(undefined);
    const document = useMemo(() => new Uint8Array(bytes), [bytes]);
    useEffect(() => () => unsubscribe.current?.(), []);
    return (
        <div ref={host} className={`${styles.host} relative flex h-full min-h-0 flex-col`} data-docx-renderer="eigenpal"
            data-toolbar-visible={toolbarVisible}
            onKeyDownCapture={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    event.stopPropagation();
                    void onSave?.();
                }
            }}>
            {fontWarning && (
                <div role="status" className="flex shrink-0 items-start gap-2 px-3 py-2 text-xs text-muted-foreground">
                    <span className="min-w-0 flex-1">Some document fonts could not be loaded. Text may look different.</span>
                    <TextButtonUI onClick={() => setFontWarning(false)}>Dismiss</TextButtonUI>
                </div>
            )}
            <DocxEditor
                document={document}
                i18n={editorLabels}
                fonts={fonts}
                mode={toolbarVisible ? mode : "view"}
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
                className="min-h-0 flex-1 overflow-auto"
                zoomMode={{ type: "fit", fit: "pageWidth", minZoom: 0.1, maxZoom: 1 }}
                onFontError={() => setFontWarning(true)}
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
                        activateRevision: ({ ins, del }) => {
                            const ids = [ins, del].filter((id): id is string => id != null);
                            // The review model includes unpainted pages. Text search
                            // can land on identical wording earlier in the document.
                            const revisions = editor.getReviewItems({ placement: false }).filter((item): item is ReviewRevisionPlacement =>
                                item.kind === "revision"
                                && item.item.ranges.some((range) => range.partName === BODY_PART)
                                && item.item.addresses.some((address) => ids.includes(address.id)),
                            );
                            if (!revisions.length) return false;
                            const owned = (revision: ReviewRevisionPlacement) =>
                                revision.item.addresses.every((address) => ids.includes(address.id));
                            if (revisions.length === 1 && owned(revisions[0])) {
                                const revision = revisions[0];
                                const result = editor.setActiveReviewItem(revision.key, { reveal: "center" });
                                if (!result.ok) return false;
                                activeRevision.current = revision.key;
                                revisionSelection.current = null;
                                citationMatch.current = null;
                                return true;
                            }
                            // Only one review item can be active. A gap can split the edit
                            // into separate native items, and EigenPal pairs a deletion
                            // with an adjacent insertion even when they are different
                            // edits, so select just this edit's ranges in document order.
                            const ranges = revisions.flatMap((revision) => editRanges(revision, ins, del))
                                .filter((range) => range.partName === BODY_PART);
                            if (!ranges.length) return false;
                            const first = ranges[0].start;
                            const last = ranges[ranges.length - 1].end;
                            const anchor = { ...first, offset: Math.min(...ranges
                                .filter((range) => range.start.paragraphId === first.paragraphId)
                                .map((range) => range.start.offset)) };
                            const head = { ...last, offset: Math.max(...ranges
                                .filter((range) => range.end.paragraphId === last.paragraphId)
                                .map((range) => range.end.offset)) };
                            // Enter the body story and reveal the edit before selecting.
                            if (!editor.setActiveReviewItem(revisions[0].key, { reveal: "center" }).ok) return false;
                            editor.setActiveReviewItem(null);
                            activeRevision.current = null;
                            if (!editor.exec({ type: "setSelection", range: { anchor, head } }).ok) return false;
                            revisionSelection.current = { anchor, text: editor.query({ type: "selectedText" }) };
                            citationMatch.current = null;
                            return true;
                        },
                        clearRevisionHighlight: () => {
                            const selection = revisionSelection.current;
                            revisionSelection.current = null;
                            if (selection && editor.query({ type: "selectedText" }) === selection.text) {
                                editor.exec({ type: "setSelection", range: { anchor: selection.anchor, head: selection.anchor } });
                            }
                            const key = activeRevision.current;
                            activeRevision.current = null;
                            // Do not dismiss a different review item the user opened.
                            if (key && editor.getReviewItems().some((item) => item.key === key && item.isActive)) {
                                editor.setActiveReviewItem(null);
                            }
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
            {toolbar && <DocxNavigationMenu toolbar={toolbar} open={navigationOpen}
                onToggle={() => setNavigationOpen((open) => !open)} />}
        </div>
    );
}
