"use client";

/**
 * Shared toast (snackbar) system for the web app and the Word add-in.
 *
 * The store is a module singleton so any layer, including non-React code
 * such as the API client, can raise a notification with `showToast`. React
 * subscribes through `useToasts`, and `ToastViewportUI` renders the stack
 * once near the root of each client, at the top centre of the page.
 *
 * The viewport also owns the slot a web `WarningPopup` renders into, so
 * popups and toasts share one column and never cover each other.
 *
 * Error toasts stay until dismissed when they carry actions, because a
 * "Retry" that vanishes mid-read is worse than none. Everything else
 * auto-dismisses and pauses while hovered or focused.
 */

import {
    useCallback,
    useEffect,
    useRef,
    useSyncExternalStore,
    type ReactElement,
} from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { NoticeCardUI, noticeActionClassName } from "./NoticeCardUI";

import {
    dismissToast,
    subscribe,
    getSnapshot,
    getServerSnapshot,
    type ToastAction,
    type ToastRecord,
} from "../lib/toastStore";
export {
    showToast,
    dismissToast,
    clearToasts,
    MAX_VISIBLE_TOASTS,
    type ToastAction,
    type ToastInput,
    type ToastRecord,
    type ToastTone,
} from "../lib/toastStore";

const toastNodes = new Map<string, HTMLElement>();

/**
 * Move keyboard focus onto a toast. Toasts never take focus on their own —
 * yanking the caret out of what the user is typing is worse than the
 * failure being reported — so a caller that must be acted on immediately
 * asks for it explicitly. Returns false when the toast is not on screen.
 */
export function focusToast(id: string): boolean {
    const node = toastNodes.get(id);
    if (!node) return false;
    node.focus();
    return true;
}

let noticeStackSlot: HTMLElement | null = null;
const noticeStackSlotListeners = new Set<() => void>();

function setNoticeStackSlot(node: HTMLElement | null) {
    if (noticeStackSlot === node) return;
    noticeStackSlot = node;
    for (const listener of noticeStackSlotListeners) listener();
}

function subscribeNoticeStackSlot(listener: () => void) {
    noticeStackSlotListeners.add(listener);
    return () => {
        noticeStackSlotListeners.delete(listener);
    };
}

/**
 * The element at the head of the mounted viewport's column, or null when no
 * viewport is mounted. `WarningPopup` portals its card here so it stacks
 * with the toasts instead of sitting on top of them.
 */
export function useNoticeStackSlot(): HTMLElement | null {
    return useSyncExternalStore(
        subscribeNoticeStackSlot,
        () => noticeStackSlot,
        () => null,
    );
}

export function toastHasActions(toast: ToastRecord): boolean {
    return Boolean(toast.actions?.length || toast.supportHref);
}

/** A toast's "Contact support" link and action buttons, for a card's action row. */
export function ToastActionsUI({ toast }: { toast: ToastRecord }): ReactElement {
    const runAction = async (action: ToastAction) => {
        if (!action.keepOpen) dismissToast(toast.id);
        await action.onClick();
    };

    return (
        <>
            {toast.supportHref && (
                <a
                    href={toast.supportHref}
                    className={noticeActionClassName()}
                >
                    {toast.supportLabel ?? "Contact support"}
                </a>
            )}
            {toast.actions?.map((action) => (
                <button
                    key={action.label}
                    type="button"
                    onClick={() => void runAction(action)}
                    className={noticeActionClassName()}
                >
                    {action.label}
                </button>
            ))}
        </>
    );
}

export function useToasts(): readonly ToastRecord[] {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function ToastItemUI({ toast }: { toast: ToastRecord }) {
    const pausedRef = useRef(false);
    const hoveredRef = useRef(false);
    const focusedRef = useRef(false);
    const deadlineRef = useRef<number | null>(null);
    const remainingRef = useRef<number | null>(toast.durationMs);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearTimer = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const arm = useCallback(() => {
        clearTimer();
        const remaining = remainingRef.current;
        if (remaining === null) return;
        deadlineRef.current = Date.now() + remaining;
        timerRef.current = setTimeout(() => dismissToast(toast.id), remaining);
    }, [clearTimer, toast.id]);

    const pause = useCallback(() => {
        if (pausedRef.current || remainingRef.current === null) return;
        pausedRef.current = true;
        if (deadlineRef.current !== null) {
            remainingRef.current = Math.max(
                1_000,
                deadlineRef.current - Date.now(),
            );
        }
        clearTimer();
    }, [clearTimer]);

    const resume = useCallback(() => {
        if (!pausedRef.current || hoveredRef.current || focusedRef.current) return;
        pausedRef.current = false;
        arm();
    }, [arm]);

    useEffect(() => {
        arm();
        return clearTimer;
    }, [arm, clearTimer]);

    const isError = toast.tone === "error";

    // The card's look lives in NoticeCardUI, shared with WarningPopup. This
    // wrapper adds only toast behaviour: the timer, hover/focus pause, and
    // the node registry `focusToast` uses.
    return (
        <NoticeCardUI
            tone={toast.tone}
            title={toast.title}
            message={toast.message}
            onDismiss={() => dismissToast(toast.id)}
            dismissLabel="Dismiss notification"
            // The item owns the live semantics: `alert` is implicitly
            // assertive, `status` polite. The viewport around it is a plain
            // region, because a live region nested in a live region is
            // announced unpredictably (or twice).
            role={isError ? "alert" : "status"}
            // Not in the tab order, but focusable so `focusToast` can put
            // the keyboard on a critical failure and its actions.
            tabIndex={-1}
            ref={(node) => {
                if (node) toastNodes.set(toast.id, node);
                else toastNodes.delete(toast.id);
            }}
            data-testid="toast"
            onMouseEnter={() => { hoveredRef.current = true; pause(); }}
            onMouseLeave={() => { hoveredRef.current = false; resume(); }}
            onFocus={() => { focusedRef.current = true; pause(); }}
            onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget)) return;
                focusedRef.current = false;
                resume();
            }}
            actions={
                toastHasActions(toast) ? (
                    <ToastActionsUI toast={toast} />
                ) : undefined
            }
        />
    );
}

export interface ToastViewportUIProps {
    /**
     * Set to false when the client draws error notices itself. The web app
     * does, with `WarningPopup`; the Word add-in has no popup and keeps the
     * default.
     */
    showErrors?: boolean;
    className?: string;
}

/**
 * Renders the toast stack. Mount exactly once per client, near the root.
 * The region is always present so assistive tech registers it before the
 * first notification arrives; the live announcement belongs to each toast,
 * not to this container.
 */
export function ToastViewportUI({
    showErrors = true,
    className,
}: ToastViewportUIProps) {
    const toasts = useToasts();
    const items = showErrors
        ? toasts
        : toasts.filter((toast) => toast.tone !== "error");

    return (
        <div
            // A landmark, not a live region: each toast announces itself
            // through its own role, and `aria-label` needs a role to be
            // exposed at all.
            role="region"
            aria-label="Notifications"
            className={twMerge(
                clsx(
                    "pointer-events-none fixed left-1/2 top-5 z-[260] flex w-[min(92vw,520px)] -translate-x-1/2 flex-col gap-2 px-4",
                ),
                className,
            )}
        >
            {/* `contents`, so popups portalled in here are flex items of
                the column and take its gap. */}
            <div ref={setNoticeStackSlot} className="contents" />
            {items.map((toast) => (
                <ToastItemUI key={toast.id} toast={toast} />
            ))}
        </div>
    );
}
