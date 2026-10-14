/**
 * The one card every notice in Mike is drawn with.
 *
 * Two components show notices, and both render this card so they cannot
 * drift apart visually:
 *
 * - `ToastViewportUI` (./ToastUI.tsx) stacks cards raised from anywhere with
 *   `showToast()`, including code that has no React component, and closes
 *   them on a timer.
 * - `WarningPopup` (app/components/popups/WarningPopup.tsx) shows a warning
 *   that stays until the user closes it. The web app draws every error with
 *   it, including the ones raised through `showToast()`.
 *
 * This file owns the look (glass surface, tone icon, title, message, action
 * row, dismiss button). It owns no behaviour: no timers, no portal, no
 * positioning, no Escape key. Those belong to the two wrappers above.
 */

import type { HTMLAttributes, ReactNode, Ref } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { LIQUID_GLASS_FLOAT_CLASS } from "./LiquidGlassUI";
import { pillButtonUIClassName } from "./PillButtonUI.styles";
import { textButtonUIClassName } from "./TextButtonUI.styles";
import { CloseButton } from "./CloseButton";
import type { ToastTone } from "../lib/toastStore";

/** Same three tones as the toast store, so a toast's tone is a card's tone. */
export type NoticeTone = ToastTone;

const toneIcon: Record<NoticeTone, ReactNode> = {
    error: (
        <AlertCircle className="h-3 w-3 shrink-0 text-red-600" aria-hidden />
    ),
    // `text-emerald-700` (not -600) because it is the shade globals.css
    // remaps for dark mode; an unmapped one stays dark on dark glass.
    success: (
        <CheckCircle2
            className="h-3 w-3 shrink-0 text-emerald-700"
            aria-hidden
        />
    ),
    info: <Info className="h-3 w-3 shrink-0 text-blue-600" aria-hidden />,
};

const toneTitleClass: Record<NoticeTone, string> = {
    error: "text-red-600",
    success: "text-emerald-700",
    info: "text-gray-900",
};

/**
 * How much weight an action in the card's `actions` row carries. No two
 * actions on one card share a look: one black pill, at most one white pill,
 * and anything further is plain text.
 */
export type NoticeActionEmphasis = "primary" | "secondary" | "tertiary";

/**
 * The emphasis of the action at `index` in a row of `count`. The last
 * action is the primary one, the one before it secondary.
 */
export function noticeActionEmphasis(
    index: number,
    count: number,
): NoticeActionEmphasis {
    const fromEnd = count - 1 - index;
    if (fromEnd <= 0) return "primary";
    return fromEnd === 1 ? "secondary" : "tertiary";
}

/** Class for a button or link placed in the card's `actions` row. */
export function noticeActionClassName(
    emphasis: NoticeActionEmphasis = "primary",
) {
    if (emphasis === "tertiary") {
        // `h-7` matches the small pills beside it.
        return textButtonUIClassName({ size: "sm", className: "h-7" });
    }
    return pillButtonUIClassName({
        tone: emphasis === "primary" ? "black" : "white",
        size: "sm",
    });
}

export interface NoticeCardUIProps
    extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "children"> {
    tone?: NoticeTone;
    title?: ReactNode;
    message?: ReactNode;
    /** Extra content under the message (lists, links, setup steps). */
    children?: ReactNode;
    /** Replaces the tone's default icon. */
    icon?: ReactNode;
    /** Buttons or links for the bottom-right action row. */
    actions?: ReactNode;
    onDismiss: () => void;
    /** Accessible name of the close button. */
    dismissLabel?: string;
    ref?: Ref<HTMLDivElement>;
}

export function NoticeCardUI({
    tone = "error",
    title,
    message,
    children,
    icon,
    actions,
    onDismiss,
    dismissLabel = "Dismiss notification",
    className,
    ref,
    ...rest
}: NoticeCardUIProps) {
    const toneIconNode = icon ?? toneIcon[tone];

    // Every popup and toast in the app moves with this markup, so change it
    // only on purpose. The dismiss control is the shared `CloseButton`, the
    // same one modals and side panels use.
    return (
        <div
            ref={ref}
            data-tone={tone}
            {...rest}
            className={twMerge(
                clsx(
                    "pointer-events-auto relative flex rounded-2xl px-3 py-2 text-xs",
                    LIQUID_GLASS_FLOAT_CLASS,
                    // Only visible when a toast is focused with the keyboard.
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                ),
                className,
            )}
        >
            <div className={clsx("min-w-0 flex-1", toneTitleClass[tone])}>
                {title ? (
                    <div className={clsx(
                        "flex items-center gap-1.5 text-sm font-medium",
                        (message || children) && "mb-1",
                    )}>
                        {toneIconNode}
                        {title}
                    </div>
                ) : null}
                {message ? (
                    <div
                        className={clsx(
                            "text-black",
                            // 18px = the 12px icon plus the 6px gap, so the
                            // message lines up under the title text.
                            title ? "pl-[18px]" : "flex items-start gap-1.5",
                        )}
                    >
                        {!title && toneIconNode}
                        {/* Setup steps carry long redirect URIs; wrap them. */}
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                            {message}
                        </span>
                    </div>
                ) : null}
                {children}
                {actions ? (
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
                        {actions}
                    </div>
                ) : null}
            </div>
            <CloseButton
                onClick={onDismiss}
                label={dismissLabel}
                size="sm"
                className="absolute right-2 top-2"
            />
        </div>
    );
}
