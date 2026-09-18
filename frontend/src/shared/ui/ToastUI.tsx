"use client";

/**
 * Shared toast (snackbar) system for the web app and the Word add-in.
 *
 * The store is a module singleton so any layer, including non-React code
 * such as the API client, can raise a notification with `showToast`. React
 * subscribes through `useToasts`, and `ToastViewportUI` renders the stack
 * once near the root of each client.
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
    type ReactNode,
} from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { LIQUID_GLASS_FLOAT_CLASS } from "./LiquidGlassUI";
import { pillButtonUIClassName } from "./PillButtonUI.styles";
import { GlassIconButtonUI } from "./GlassIconButtonUI";

export type ToastTone = "error" | "success" | "info";

export interface ToastAction {
    label: string;
    onClick: () => void | Promise<void>;
    /** Keep the toast open after the action runs. Default: dismiss. */
    keepOpen?: boolean;
}

export interface ToastInput {
    tone?: ToastTone;
    title?: string;
    message: ReactNode;
    /**
     * Milliseconds before auto-dismiss. `null` keeps the toast until the
     * user closes it. Defaults: error 10s (sticky when it has actions),
     * success/info 4s.
     */
    durationMs?: number | null;
    actions?: ToastAction[];
    /** A `mailto:` or URL for a "Contact support" link. */
    supportHref?: string;
    supportLabel?: string;
    /**
     * Toasts sharing a dedupe key replace each other instead of stacking,
     * so a polling loop that fails five times shows one toast.
     */
    dedupeKey?: string;
}

export interface ToastRecord extends ToastInput {
    id: string;
    tone: ToastTone;
    createdAt: number;
    durationMs: number | null;
}

const DEFAULT_DURATION: Record<ToastTone, number> = {
    error: 10_000,
    success: 4_000,
    info: 5_000,
};

export const MAX_VISIBLE_TOASTS = 3;

type Listener = () => void;

/**
 * A toast the user still has to act on: an error carrying "Retry" or
 * "Contact support". It is the one kind the stack must not evict to make
 * room for a "Saved" notice.
 */
function isActionableError(toast: ToastRecord): boolean {
    return (
        toast.tone === "error" &&
        Boolean(toast.actions?.length || toast.supportHref)
    );
}

/**
 * Trim the stack to `MAX_VISIBLE_TOASTS`, dropping dismissible chatter
 * (info/success, and errors with nothing to click) oldest-first and only
 * then falling back to actionable errors. The newest toast is always kept:
 * it is the one that just happened.
 */
function trimToStack(next: readonly ToastRecord[]): readonly ToastRecord[] {
    let excess = next.length - MAX_VISIBLE_TOASTS;
    if (excess <= 0) return next;

    const newest = next[next.length - 1];
    const dropped = new Set<string>();
    for (const toast of next) {
        if (excess === 0) break;
        if (toast === newest || isActionableError(toast)) continue;
        dropped.add(toast.id);
        excess -= 1;
    }
    for (const toast of next) {
        if (excess === 0) break;
        if (toast === newest || dropped.has(toast.id)) continue;
        dropped.add(toast.id);
        excess -= 1;
    }
    return next.filter((toast) => !dropped.has(toast.id));
}

let toasts: readonly ToastRecord[] = [];
const listeners = new Set<Listener>();
let counter = 0;

function emit() {
    for (const listener of listeners) listener();
}

function nextId() {
    counter += 1;
    return `toast-${counter}`;
}

function resolveDuration(input: ToastInput, tone: ToastTone): number | null {
    if (input.durationMs !== undefined) return input.durationMs;
    if (tone === "error" && (input.actions?.length || input.supportHref)) {
        return null;
    }
    return DEFAULT_DURATION[tone];
}

export function showToast(input: ToastInput): string {
    const tone = input.tone ?? "info";
    const record: ToastRecord = {
        ...input,
        tone,
        id: nextId(),
        createdAt: Date.now(),
        durationMs: resolveDuration(input, tone),
    };
    const kept = input.dedupeKey
        ? toasts.filter((toast) => toast.dedupeKey !== input.dedupeKey)
        : toasts;
    toasts = trimToStack([...kept, record]);
    emit();
    return record.id;
}

export function dismissToast(id: string) {
    if (!toasts.some((toast) => toast.id === id)) return;
    toasts = toasts.filter((toast) => toast.id !== id);
    emit();
}

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

export function clearToasts() {
    if (toasts.length === 0) return;
    toasts = [];
    emit();
}

function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot() {
    return toasts;
}

const EMPTY: readonly ToastRecord[] = [];
function getServerSnapshot() {
    return EMPTY;
}

export function useToasts(): readonly ToastRecord[] {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const toneIcon: Record<ToastTone, ReactNode> = {
    error: <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden />,
    // `text-emerald-700` (not -600) because it is the shade globals.css
    // remaps for dark mode; an unmapped one stays dark on dark glass.
    success: (
        <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-emerald-700"
            aria-hidden
        />
    ),
    info: <Info className="h-3.5 w-3.5 shrink-0 text-blue-600" aria-hidden />,
};

const toneTitleClass: Record<ToastTone, string> = {
    error: "text-red-600",
    success: "text-emerald-700",
    info: "text-gray-900",
};

function ToastItemUI({ toast }: { toast: ToastRecord }) {
    const pausedRef = useRef(false);
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
        if (!pausedRef.current) return;
        pausedRef.current = false;
        arm();
    }, [arm]);

    useEffect(() => {
        arm();
        return clearTimer;
    }, [arm, clearTimer]);

    const runAction = async (action: ToastAction) => {
        if (!action.keepOpen) dismissToast(toast.id);
        await action.onClick();
    };

    const isError = toast.tone === "error";

    return (
        <div
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
            data-tone={toast.tone}
            data-testid="toast"
            onMouseEnter={pause}
            onMouseLeave={resume}
            onFocus={pause}
            onBlur={resume}
            className={twMerge(
                clsx(
                    "pointer-events-auto relative flex rounded-2xl px-3 py-3 text-xs",
                    LIQUID_GLASS_FLOAT_CLASS,
                    "backdrop-blur-2xl",
                ),
            )}
        >
            <div className="min-w-0 flex-1 pr-6">
                <div
                    className={clsx(
                        "flex items-start gap-1.5",
                        toast.title ? "mb-1 text-sm font-medium" : "",
                        toast.title ? toneTitleClass[toast.tone] : "text-gray-900",
                    )}
                >
                    {toneIcon[toast.tone]}
                    <span className="min-w-0">
                        {toast.title ?? toast.message}
                    </span>
                </div>
                {toast.title && (
                    <div className="pl-5 text-gray-900">{toast.message}</div>
                )}
                {(toast.actions?.length || toast.supportHref) && (
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5 pl-5">
                        {toast.supportHref && (
                            <a
                                href={toast.supportHref}
                                className={pillButtonUIClassName({
                                    tone: "white",
                                    size: "xs",
                                })}
                            >
                                {toast.supportLabel ?? "Contact support"}
                            </a>
                        )}
                        {toast.actions?.map((action) => (
                            <button
                                key={action.label}
                                type="button"
                                onClick={() => void runAction(action)}
                                className={pillButtonUIClassName({
                                    tone: "black",
                                    size: "xs",
                                })}
                            >
                                {action.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <GlassIconButtonUI
                onClick={() => dismissToast(toast.id)}
                className="absolute right-1.5 top-1.5 h-5 w-5"
                aria-label="Dismiss notification"
            >
                <X className="h-3 w-3" />
            </GlassIconButtonUI>
        </div>
    );
}

export interface ToastViewportUIProps {
    position?: "bottom-center" | "top-center";
    className?: string;
}

const positionClass: Record<
    NonNullable<ToastViewportUIProps["position"]>,
    string
> = {
    "bottom-center": "bottom-5 left-1/2 -translate-x-1/2",
    "top-center": "top-5 left-1/2 -translate-x-1/2",
};

/**
 * Renders the toast stack. Mount exactly once per client, near the root.
 * The region is always present so assistive tech registers it before the
 * first notification arrives; the live announcement belongs to each toast,
 * not to this container.
 */
export function ToastViewportUI({
    position = "bottom-center",
    className,
}: ToastViewportUIProps) {
    const items = useToasts();

    return (
        <div
            // A landmark, not a live region: each toast announces itself
            // through its own role, and `aria-label` needs a role to be
            // exposed at all.
            role="region"
            aria-label="Notifications"
            className={twMerge(
                clsx(
                    "pointer-events-none fixed z-[260] flex w-[min(92vw,460px)] flex-col gap-2 px-4",
                    positionClass[position],
                ),
                className,
            )}
        >
            {items.map((toast) => (
                <ToastItemUI key={toast.id} toast={toast} />
            ))}
        </div>
    );
}
