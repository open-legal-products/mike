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
 * Class for a button or link placed in the card's `actions` row. Every
 * notice action is a small black pill, so it takes no tone.
 */
export function noticeActionClassName() {
    return pillButtonUIClassName({ tone: "black", size: "sm" });
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
                    "pointer-events-auto relative flex rounded-2xl px-3 py-3 text-xs",
                    LIQUID_GLASS_FLOAT_CLASS,
                    // Only visible when a toast is focused with the keyboard.
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                ),
                className,
            )}
        >
            <div className={clsx("min-w-0 flex-1", toneTitleClass[tone])}>
                {title ? (
                    <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
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
                size="md"
                className="absolute right-1.5 top-1.5"
            />
        </div>
    );
}
