"use client";

import { createPortal } from "react-dom";
import { useEffect, type ReactNode } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { NoticeCardUI } from "@/shared/ui/NoticeCardUI";

/**
 * A single warning that the calling component opens and closes itself.
 *
 * Its card is `NoticeCardUI`, the same card the toast stack draws, so a
 * popup and a toast always look alike. This wrapper adds only what a popup
 * needs on top: the `open` prop, a portal to the top centre of the page, and
 * closing on Escape.
 *
 * Use a WarningPopup when the message is about something the user just did
 * on this screen and should stay until they close it. Use `notifyError` /
 * `showToast` when the message comes from background work or from code that
 * has no component of its own. docs/design-system.md has the full rule.
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
    className,
}: WarningPopupProps) {
    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onClose, open]);

    if (!open) return null;

    return createPortal(
        <div className="pointer-events-none fixed left-1/2 top-5 z-[220] w-[min(92vw,520px)] -translate-x-1/2 px-4">
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
                    primaryAction ? (
                        <PillButtonUI
                            tone="black"
                            size="sm"
                            onClick={primaryAction.onClick}
                            disabled={primaryAction.disabled}
                        >
                            {primaryAction.label}
                        </PillButtonUI>
                    ) : undefined
                }
            >
                {children}
            </NoticeCardUI>
        </div>,
        document.body,
    );
}
