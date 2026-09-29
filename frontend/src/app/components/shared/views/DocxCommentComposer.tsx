"use client";
// Render reads the mutable editor facade (snapshot, review items); React
// Compiler would cache those reads per editor instance and go stale.
"use no memo";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus } from "lucide-react";
import type { Editor } from "@docx-editor.dev/core/contracts/editor";
import { useEditorSnapshot } from "@docx-editor.dev/react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";

/** Mike-owned comment UI, using only the public open-source Editor contract. */
export function DocxCommentComposer({
  editor,
  author,
  toolbar,
  surface = null,
}: {
  editor: Editor;
  author?: string;
  toolbar: HTMLElement | null;
  /** Page surface; the composer opens below the selected text painted in it. */
  surface?: HTMLElement | null;
}) {
  useEditorSnapshot(editor);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [anchorBox, setAnchorBox] = useState<AnchorBox | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Keep both comment actions in EigenPal's measured, always-visible review
  // group so they stay together when formatting controls move into More.
  const commentToolbar = toolbar?.querySelector('[data-slot="review.comments"]')
    ?.closest<HTMLElement>(".docx-toolbar__group") ?? toolbar;
  // Below the selected passage while composing, else beside the button.
  const anchor = useMemo(() => {
    const box = composing ? anchorBox : null;
    return {
      current: {
        getBoundingClientRect: () => {
          if (!box || !surface)
            return button.current?.getBoundingClientRect() ?? new DOMRect();
          const page = surface.getBoundingClientRect();
          return new DOMRect(
            page.left + box.left,
            page.top + box.top,
            box.width,
            0,
          );
        },
      },
    };
  }, [composing, anchorBox, surface]);
  const pin = useRef<ReturnType<Editor["retainSelection"]>>(null);
  const anchorRange = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const snapshot = editor.snapshot();
  const editable = snapshot.editable && snapshot.editingMode !== "viewing";
  const hasAuthor = !!author?.trim();
  const unavailable = !editable
    ? "This document is read-only."
    : !hasAuthor
      ? "An author name is required to add comments."
      : null;

  useEffect(
    () => () => {
      if (pin.current) editor.releaseSelection(pin.current);
      pin.current = null;
    },
    [editor],
  );
  const release = () => {
    if (pin.current) editor.releaseSelection(pin.current);
    pin.current = null;
    anchorRange.current = null;
  };
  const dismiss = () => {
    release();
    setComposing(false);
    setDraft("");
    setError(null);
    setAnchorBox(null);
  };
  const start = () => {
    if (composing) {
      input.current?.focus();
      return;
    }
    if (unavailable) return;
    // Read the model range at click time. Its screen placement can be null
    // when a selected page is virtualized, even though the range is valid.
    const range = editor.query({ type: "selection" });
    if (!range || editor.snapshot().selectionCollapsed) {
      setError("Select text in the document, then choose New comment.");
      return;
    }
    const retained = editor.retainSelection();
    if (!retained) {
      setError("Select the passage again, then choose New comment.");
      return;
    }
    pin.current = retained;
    anchorRange.current = JSON.stringify(range);
    setAnchorBox(surface ? docxSelectionAnchor(surface) : null);
    setError(null);
    setStatus("");
    setComposing(true);
  };
  const submit = () => {
    if (!draft.trim() || !editable || !hasAuthor) return;
    if (
      anchorRange.current !==
      JSON.stringify(editor.query({ type: "selection" }))
    ) {
      setError(
        "The selected passage changed. Your draft is still here; cancel and select the passage again before adding the comment.",
      );
      return;
    }
    try {
      // Core owns anchoring, protection, history and OOXML serialization.
      // Its change event feeds the existing DOCX autosave pipeline.
      const result = editor.addComment(draft.trim(), author);
      if (!result.ok) {
        setError(
          "This comment could not be added. Your draft is still here; try again or cancel to choose another passage.",
        );
        return;
      }
      release();
      setDraft("");
      setComposing(false);
      setError(null);
      setAnchorBox(null);
      setStatus("Comment added.");
      if (!editor.snapshot().reviewPaneOpen)
        editor.exec({ type: "toggleReviewPane" });
    } catch {
      setError(
        "This comment could not be added. Your draft is still here; please try again.",
      );
    }
  };

  return (
    <>
      {commentToolbar &&
        createPortal(
          <span
            data-toolbar-fixed={commentToolbar === toolbar ? "" : undefined}
            className="-order-1 flex flex-none items-center"
          >
            <Popover
              open={composing || error !== null}
              onOpenChange={(open) => {
                if (!open) dismiss();
              }}
            >
              <PopoverTrigger asChild>
                <TextButtonUI
                  ref={button}
                  size="icon-xs"
                  aria-label="New comment"
                  title={unavailable ?? "New comment"}
                  disabled={!composing && !!unavailable}
                  className="h-6"
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    // Keep an existing draft open on repeat clicks.
                    event.preventDefault();
                    start();
                  }}
                >
                  <MessageSquarePlus aria-hidden="true" className="h-4 w-4" />
                </TextButtonUI>
              </PopoverTrigger>
              {/* Always mounted: toggling a custom anchor remounts
                            the trigger, which would reorder the toolbar. */}
              <PopoverAnchor virtualRef={anchor} />
              <PopoverContent
                aria-label="New comment"
                align={composing && anchorBox ? "start" : "end"}
                // The selection anchor moves with page scroll and zoom.
                updatePositionStrategy={
                  composing && anchorBox ? "always" : "optimized"
                }
                side="bottom"
                sideOffset={8}
                collisionPadding={12}
                className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto text-xs text-foreground"
                onOpenAutoFocus={(event) => {
                  if (input.current) {
                    event.preventDefault();
                    input.current.focus();
                  }
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {composing && (
                  <form
                    className="space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submit();
                    }}
                  >
                    <label htmlFor={id} className="block font-medium">
                      New comment
                    </label>
                    <textarea
                      id={id}
                      ref={input}
                      rows={3}
                      value={draft}
                      className="keyboard-focus-ring w-full min-h-24 max-h-48 resize-y rounded-xl bg-[var(--dropdown-input-background)] px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
                      placeholder="Write a comment…"
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          (event.metaKey || event.ctrlKey) &&
                          event.key === "Enter"
                        ) {
                          event.preventDefault();
                          submit();
                        }
                      }}
                    />
                    {!editable && (
                      <p className="text-muted-foreground">
                        This document is read-only. Your draft is kept until you
                        cancel.
                      </p>
                    )}
                    <div className="flex items-center justify-end gap-2">
                      <TextButtonUI onClick={dismiss}>Cancel</TextButtonUI>
                      <PillButtonUI
                        type="submit"
                        tone="black"
                        size="xs"
                        disabled={!draft.trim() || !editable || !hasAuthor}
                      >
                        Add comment
                      </PillButtonUI>
                    </div>
                  </form>
                )}
                {error && (
                  <p role="alert" className="mt-2 text-destructive">
                    {error}
                  </p>
                )}
              </PopoverContent>
            </Popover>
          </span>,
          commentToolbar,
        )}
      <span role="status" className="sr-only">
        {status}
      </span>
    </>
  );
}

type AnchorBox = { left: number; top: number; width: number };

/**
 * The bottom edge of the painted selection's last line, in page-surface
 * coordinates. Null when the selection is not painted, e.g. on a virtualized
 * page; the composer then stays beside its toolbar button.
 */
export function docxSelectionAnchor(surface: HTMLElement): AnchorBox | null {
  const overlay = surface.querySelector<HTMLElement>(
    ":scope > .docx-selection-overlay",
  );
  const rects = [...(overlay?.children ?? [])]
    .filter((rect): rect is HTMLElement => rect instanceof HTMLElement)
    .map((rect) => ({
      left: rect.offsetLeft,
      right: rect.offsetLeft + rect.offsetWidth,
      bottom: rect.offsetTop + rect.offsetHeight,
    }))
    .filter((rect) => rect.right > rect.left);
  if (!rects.length) return null;
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const lastLine = rects.filter((rect) => rect.bottom >= bottom - 1);
  const left = Math.min(...lastLine.map((rect) => rect.left));
  return {
    left,
    top: bottom,
    width: Math.max(...lastLine.map((rect) => rect.right)) - left,
  };
}
