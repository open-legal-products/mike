"use client";

import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { AlertCircle, X } from "lucide-react";
import { GlassIconButtonUI } from "@/shared/ui/GlassIconButtonUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";

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
    if (!open) return null;

    const warningIcon = icon ?? (
        <AlertCircle className="h-3 w-3 shrink-0 text-red-600" />
    );

    return createPortal(
        <div className="pointer-events-none fixed left-1/2 top-5 z-[220] w-[min(92vw,520px)] -translate-x-1/2 px-4">
            <div
                className={cn(
                    `pointer-events-auto relative flex rounded-2xl px-3 py-3 text-xs ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`,
                    className,
                )}
            >
                <div className="min-w-0 flex-1 text-red-600">
                    {title && (
                        <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                            {warningIcon}
                            {title}
                        </div>
                    )}
                    {message && (
                        <div
                            className={cn(
                                "text-black",
                                title
                                    ? "pl-[18px]"
                                    : "flex items-start gap-1.5",
                            )}
                        >
                            {!title && warningIcon}
                            <span className="min-w-0">{message}</span>
                        </div>
                    )}
                    {children}
                    {primaryAction && (
                        <div className="mt-2 flex items-center justify-end">
                            <PillButtonUI
                                tone="black"
                                size="sm"
                                onClick={primaryAction.onClick}
                                disabled={primaryAction.disabled}
                            >
                                {primaryAction.label}
                            </PillButtonUI>
                        </div>
                    )}
                </div>
                <GlassIconButtonUI
                    onClick={onClose}
                    className="absolute right-1.5 top-1.5 h-5 w-5"
                    aria-label="Dismiss warning"
                >
                    <X className="h-3 w-3" />
                </GlassIconButtonUI>
            </div>
        </div>,
        document.body,
    );
}
