import React from "react";
import { PillButtonUI as PillButton } from "@mike/pill-button-ui";
import { describeError } from "@mike/user-error";
import { handOffToSupport } from "../../lib/notify";

/**
 * What the pane shows when a render error escapes every component. The
 * error itself has already been sent to Sentry by the boundary; this only
 * has to leave the user a way back that does not involve restarting Word:
 * re-mount the pane, or mail support with the details.
 */
export function PaneErrorFallback({
  resetError,
}: {
  resetError: () => void;
}): React.ReactElement {
  // The thrown value is a programming fault, never copy for a user, so only
  // the classification travels to support.
  const described = describeError(null, { action: "open Mike" });
  const contactSupport = (): void => {
    void handOffToSupport(described, {
      note: "The Word task pane failed to render.",
      page: "Task pane",
    });
  };
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-sm font-medium text-foreground">Something went wrong</p>
      <p className="text-xs text-muted-foreground">
        Mike couldn&rsquo;t finish loading this pane. It has been reported. Try
        again, and contact support if it keeps happening.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <PillButton type="button" tone="black" size="normal" onClick={resetError}>
          Try again
        </PillButton>
        <button
          type="button"
          onClick={contactSupport}
          className="rounded-full px-3 py-1.5 text-xs text-gray-700 underline underline-offset-2 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          Contact support
        </button>
      </div>
    </div>
  );
}
