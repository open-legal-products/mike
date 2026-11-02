"use client";

/**
 * Web adapter for the shared toast system. Mount `<AppToasts />` once in the
 * root providers. It renders the viewport, draws every error notice as a
 * `WarningPopup`, and raises a single offline notice while the browser
 * reports no connection.
 */

import { useEffect } from "react";
import {
    ToastActionsUI,
    ToastViewportUI,
    dismissToast,
    showToast,
    toastHasActions,
    useToasts,
} from "@/shared/ui/ToastUI";
import { WarningPopup } from "@/app/components/popups/WarningPopup";

export {
    ToastViewportUI,
    clearToasts,
    dismissToast,
    showToast,
    useToasts,
    type ToastAction,
    type ToastInput,
    type ToastRecord,
    type ToastTone,
} from "@/shared/ui/ToastUI";

export const OFFLINE_TOAST_KEY = "connectivity";

export function useOfflineNotice() {
    useEffect(() => {
        let offlineToastId: string | null = null;

        const onOffline = () => {
            offlineToastId = showToast({
                tone: "error",
                title: "You're offline",
                message:
                    "Changes can't be saved until your connection is back.",
                durationMs: null,
                dedupeKey: OFFLINE_TOAST_KEY,
            });
        };
        const onOnline = () => {
            if (offlineToastId) {
                dismissToast(offlineToastId);
                offlineToastId = null;
                showToast({
                    tone: "success",
                    message: "You're back online.",
                    dedupeKey: OFFLINE_TOAST_KEY,
                });
            }
        };

        window.addEventListener("offline", onOffline);
        window.addEventListener("online", onOnline);
        if (navigator.onLine === false) onOffline();
        return () => {
            window.removeEventListener("offline", onOffline);
            window.removeEventListener("online", onOnline);
        };
    }, []);
}

export function AppToasts() {
    useOfflineNotice();
    const warnings = useToasts().filter((toast) => toast.tone === "error");

    return (
        <>
            <ToastViewportUI showErrors={false} />
            {warnings.map((toast) => (
                <WarningPopup
                    key={toast.id}
                    open
                    title={toast.title}
                    message={toast.message}
                    onClose={() => dismissToast(toast.id)}
                    actions={
                        toastHasActions(toast) ? (
                            <ToastActionsUI toast={toast} />
                        ) : undefined
                    }
                />
            ))}
        </>
    );
}
