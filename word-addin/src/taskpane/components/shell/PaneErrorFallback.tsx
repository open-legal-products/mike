import React from "react";
import { PillButtonUI as PillButton } from "@mike/pill-button-ui";

/**
 * What the pane shows when a render error escapes every component. The
 * error itself has already been sent to Sentry by the boundary; this only
 * has to leave the user a way back that does not involve restarting Word.
 */
export function PaneErrorFallback({
  resetError,
}: {
  resetError: () => void;
}): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-sm font-medium text-foreground">Something went wrong</p>
      <p className="text-xs text-muted-foreground">
        The add-in hit an unexpected error. It has been reported.
      </p>
      <PillButton type="button" tone="black" size="normal" onClick={resetError}>
        Try again
      </PillButton>
    </div>
  );
}
