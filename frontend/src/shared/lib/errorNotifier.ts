/**
 * The part of "tell the user something failed" that is the same in the web
 * app and the Word add-in.
 *
 * `describeError` decides what to say. This module turns that into one error
 * toast: a cancellation the user caused is not shown, an honest "Retry" is
 * offered only when re-running can help, and a retry that fails again is
 * reported again. Each client adds only what differs (the web app's support
 * link and "Sign in"; the add-in's support hand-off and session recovery)
 * through `createErrorNotifier`, so the shared rules cannot drift apart.
 *
 * Shared by both clients, so it must stay framework-free and must not import
 * from `frontend/src/app/`.
 */
import {
    describeError,
    type DescribeErrorOptions,
    type UserFacingError,
} from "./userError";
import { retryToastAction, showToast, type ToastAction } from "./toastStore";

export interface NotifyErrorOptions extends DescribeErrorOptions {
    /** Re-run the failed action. Offered only when a retry is honest. */
    onRetry?: () => void | Promise<void>;
    /** Collapse repeats (polling loops, autosave) into one toast. */
    dedupeKey?: string;
    /** Force the support link on or off regardless of classification. */
    support?: boolean;
    /** Extra actions beyond Retry. */
    actions?: ToastAction[];
    /** Extra text for the support email body, e.g. which document. */
    supportNote?: string;
}

/** What one client adds to the shared error toast. */
export interface ErrorNotifierClient<O extends NotifyErrorOptions> {
    /** Adjust the options `describeError` sees, e.g. client-owned copy. */
    describeOptions?: (error: unknown, options: O) => O;
    /**
     * Runs once a failure is described and is not a cancellation, before
     * anything is shown. Return true when the failure was already handled
     * elsewhere and no toast should be raised for it.
     */
    beforeShow?: (
        error: unknown,
        described: UserFacingError,
        options: O,
    ) => boolean;
    /**
     * The client's own actions, placed after Retry, and how it offers
     * "Contact support" when `wantsSupport` is true.
     */
    present: (
        described: UserFacingError,
        options: O,
        wantsSupport: boolean,
    ) => { actions?: ToastAction[]; supportHref?: string };
}

/**
 * Build a client's `notifyError`. The returned function shows a failure and
 * returns its description so the caller can also render it inline, or
 * `null` when the failure is a cancellation the user does not need to hear
 * about.
 */
export function createErrorNotifier<O extends NotifyErrorOptions>(
    client: ErrorNotifierClient<O>,
): (error: unknown, options?: O) => UserFacingError | null {
    const notify = (
        error: unknown,
        options: O = {} as O,
    ): UserFacingError | null => {
        const described = describeError(
            error,
            client.describeOptions ? client.describeOptions(error, options) : options,
        );
        if (described.kind === "aborted") return null;
        if (client.beforeShow?.(error, described, options)) return described;

        // warn, not error: Sentry's console bridge forwards console.error, and
        // a 4xx or a cancellation the user just saw is not an incident. Real
        // faults are reported where they are caught, or by `beforeShow`.
        if (process.env.NODE_ENV !== "production") {
            console.warn("[user-error]", described.title, described.cause);
        }

        const own = client.present(
            described,
            options,
            options.support ?? described.supportable,
        );
        const actions: ToastAction[] = [...(options.actions ?? [])];
        if (options.onRetry && described.retryable) {
            actions.push(
                retryToastAction(options.onRetry, (retryError) =>
                    notify(retryError, options),
                ),
            );
        }
        actions.push(...(own.actions ?? []));

        showToast({
            tone: "error",
            title: described.title,
            message: described.message,
            actions,
            supportHref: own.supportHref,
            dedupeKey: options.dedupeKey,
        });

        return described;
    };
    return notify;
}

export function notifySuccess(message: string, title?: string): string {
    return showToast({ tone: "success", title, message });
}

export function notifyInfo(message: string, title?: string): string {
    return showToast({ tone: "info", title, message });
}
