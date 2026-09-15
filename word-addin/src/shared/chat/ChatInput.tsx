"use client";

import * as React from "react";
import { ArrowRight, Square } from "lucide-react";

import { cn } from "../lib/utils";

interface ChatInputProps {
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    isLoading?: boolean;
    onCancel?: () => void;
    placeholder?: string;
    disabled?: boolean;
    /** Accessory controls rendered on the left of the action row (e.g. a toggle). */
    leftSlot?: React.ReactNode;
    /** Accessory controls rendered immediately before the send/stop button. */
    rightSlot?: React.ReactNode;
    /** Workflow and document pills rendered inside the glass composer. */
    attachments?: React.ReactNode;
    className?: string;
    onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
    combobox?: {
        controls?: string;
        expanded: boolean;
        activeDescendant?: string;
    };
}

/**
 * Presentational chat composer shell shared across surfaces, duplicated from
 * the web app's composer (frontend/src/app/components/assistant/ChatInput.tsx):
 * the same liquid-glass container and gradient-black square action button,
 * laid out to fit a narrow task-pane column. Enter submits; Shift+Enter
 * inserts a newline. The action button flips between send (arrow) and stop
 * (square) exactly like the web's single action button.
 */
export function ChatInput({
    value,
    onValueChange,
    onSubmit,
    isLoading = false,
    onCancel,
    placeholder = "How can I help?",
    disabled = false,
    leftSlot,
    rightSlot,
    attachments,
    className,
    onKeyDown,
    combobox,
}: ChatInputProps) {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const inputAreaRef = React.useRef<HTMLDivElement>(null);

    // 160px is the effective cap: a narrow-pane adaptation tighter than the
    // web composer's max-h-48 (192px), which the textarea also carries so a
    // growing value can never swallow the pane before this effect runs.
    const resizeTextarea = React.useCallback((): void => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "0px";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }, []);

    // Auto-grow when content changes.
    React.useEffect(() => {
        resizeTextarea();
    }, [resizeTextarea, value]);

    // A width-only pane resize can wrap existing text onto more lines without
    // changing its value. Re-measure that stable input-area width so the
    // bottom-anchored composer grows upward instead of clipping those lines.
    React.useEffect(() => {
        const inputArea = inputAreaRef.current;
        if (!inputArea || typeof ResizeObserver === "undefined") return;
        let previousWidth = inputArea.getBoundingClientRect().width;
        let resizeFrame: number | null = null;
        const observer = new ResizeObserver((entries) => {
            const width =
                entries[0]?.contentRect.width ?? inputArea.offsetWidth;
            if (Math.abs(width - previousWidth) < 0.5) return;
            previousWidth = width;
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
            // Changing the textarea height inside the observer callback can
            // resize the observed input area again in the same delivery cycle.
            // Defer the write to the next frame to avoid ResizeObserver loops
            // while Word's task pane is being dragged narrower or wider.
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = null;
                resizeTextarea();
            });
        });
        observer.observe(inputArea);
        return () => {
            observer.disconnect();
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        };
    }, [resizeTextarea]);

    const handleKeyDown = (
        e: React.KeyboardEvent<HTMLTextAreaElement>,
    ): void => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (value.trim() && !isLoading && !disabled) onSubmit();
        }
    };

    const canSend = !!value.trim() && !isLoading && !disabled;

    return (
        <div
            data-testid="chat-input"
            className={cn(
                "rounded-[21px] border border-white/65 bg-white/60 shadow-[0_4px_10px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.85),inset_0_-6px_14px_rgba(255,255,255,0.18)] backdrop-blur-2xl",
                className,
            )}
        >
            {attachments && (
                <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                    {attachments}
                </div>
            )}
            <div ref={inputAreaRef} className="px-4 pt-4">
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={value}
                    onChange={(e) => onValueChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    role={combobox ? "combobox" : undefined}
                    aria-autocomplete={combobox ? "list" : undefined}
                    aria-controls={combobox?.controls}
                    aria-expanded={combobox?.expanded}
                    aria-activedescendant={combobox?.activeDescendant}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="max-h-48 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-60"
                />
            </div>
            <div className="flex items-center justify-between gap-2 p-2">
                <div className="flex min-w-0 items-center gap-2">
                    {leftSlot}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {rightSlot}
                    <button
                        type="button"
                        onClick={() =>
                            isLoading ? onCancel?.() : canSend && onSubmit()
                        }
                        disabled={!isLoading && !canSend}
                        aria-label={isLoading ? "Stop response" : "Send message"}
                        className={cn(
                            "relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[11px] border-0 bg-gradient-to-b from-neutral-700 to-black text-white backdrop-blur-xl transition-all duration-150 active:enabled:scale-95 disabled:cursor-default disabled:from-neutral-600 disabled:to-black",
                            "shadow-[0_3px_9px_rgba(15,23,42,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.10),inset_-4px_-4px_9px_rgba(15,23,42,0.2)]",
                        )}
                    >
                        {isLoading ? (
                            <Square
                                className="h-4 w-4"
                                fill="currentColor"
                                strokeWidth={0}
                            />
                        ) : (
                            <ArrowRight className="h-4 w-4" />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
