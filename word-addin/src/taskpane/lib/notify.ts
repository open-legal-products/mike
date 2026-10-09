/** Passive task-pane notifications; recovery actions are reviewed separately. */
import { describeError, type DescribeErrorOptions, type UserFacingError } from "@mike/user-error";
import { showToast } from "@mike/toast-store";

export function notifyError(error: unknown, options: DescribeErrorOptions & { dedupeKey?: string } = {}): UserFacingError | null {
  const described = describeError(error, options);
  if (described.kind === "aborted") return null;
  // Sentry's existing global handler reports unhandled rejections.
  showToast({ tone: "error", title: described.title, message: described.message, dedupeKey: options.dedupeKey });
  return described;
}
