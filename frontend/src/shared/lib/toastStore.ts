/** Framework-independent notification store, usable by API clients and Node tests. */
import type { ReactNode } from "react";

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
 * "Contact support". These errors take priority over transient notices.
 */
function isActionableError(toast: ToastRecord): boolean {
    return (
        toast.tone === "error" &&
        Boolean(toast.actions?.length || toast.supportHref)
    );
}

/**
 * Trim the stack to `MAX_VISIBLE_TOASTS`, dropping dismissible chatter
 * oldest-first and only then falling back to persistent notices and
 * actionable errors. The newest toast is always kept:
 * it is the one that just happened.
 */
function trimToStack(next: readonly ToastRecord[]): readonly ToastRecord[] {
    let excess = next.length - MAX_VISIBLE_TOASTS;
    if (excess <= 0) return next;

    const newest = next[next.length - 1];
    const dropped = new Set<string>();
    for (const toast of next) {
        if (excess === 0) break;
        if (toast === newest || isActionableError(toast) || toast.durationMs === null) continue;
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

export function clearToasts() {
    if (toasts.length === 0) return;
    toasts = [];
    emit();
}

export function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getSnapshot() {
    return toasts;
}

const EMPTY: readonly ToastRecord[] = [];
export function getServerSnapshot() {
    return EMPTY;
}
