"use client";

import { createPortal } from "react-dom";
import { useEffect, type ReactNode } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { NoticeCardUI } from "@/shared/ui/NoticeCardUI";
import { useNoticeStackSlot } from "@/shared/ui/ToastUI";

/**
 * A single warning that the calling component opens and closes itself.
 *
 * Its card is `NoticeCardUI`, the same card the toast stack draws, so a
 * popup and a toast always look alike. This wrapper adds only what a popup
 * needs on top: the `open` prop, a portal to the top centre of the page, and
 * closing on Escape.
 *
 * Every warning in the web app is a WarningPopup. A component renders one
 * for a failure on its own screen; `notifyError` reaches code that has no
 * component, and `AppToasts` draws what it raises with this same popup.
 * Toasts are for success and information. docs/design-system.md has the
 * full rule.
 *
 * While the toast viewport is mounted the card joins its column, so a popup
 * and a toast stack instead of overlapping.
 */

interface WarningPopupAction {
    label: ReactNode;
    onClick: () => void;
    disabled?: boolean;
}

interface WarningPopupProps {
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    message?: ReactNode;
    children?: ReactNode;
    icon?: ReactNode;
    primaryAction?: WarningPopupAction;
    /** Extra buttons or links for the action row, before `primaryAction`. */
    actions?: ReactNode;
    className?: string;
}

export function WarningPopup({
    open,
    onClose,
    title,
    message,
    children,
    icon,
    primaryAction,
    actions,
    className,
}: WarningPopupProps) {
    const stackSlot = useNoticeStackSlot();

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onClose, open]);

    if (!open) return null;

    const card = (
        <NoticeCardUI
            tone="error"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            title={title}
            message={message}
            icon={icon}
            onDismiss={onClose}
            dismissLabel="Dismiss warning"
            className={className}
            actions={
                actions || primaryAction ? (
                    <>
                        {actions}
                        {primaryAction ? (
                            <PillButtonUI
                                tone="black"
                                size="sm"
                                onClick={primaryAction.onClick}
                                disabled={primaryAction.disabled}
                            >
                                {primaryAction.label}
                            </PillButtonUI>
                        ) : null}
                    </>
                ) : undefined
            }
        >
            {children}
        </NoticeCardUI>
    );

    if (stackSlot) return createPortal(card, stackSlot);

    return createPortal(
        <div className="pointer-events-none fixed left-1/2 top-5 z-[220] w-[min(92vw,520px)] -translate-x-1/2 px-4">
            {card}
        </div>,
        document.body,
    );
}
