import React from "react";

/**
 * What taskpane.html shows when Office.js reports no host: the page was
 * opened in a plain browser tab (a pasted link, a crawler, a link preview)
 * rather than inside Word. Nothing in the pane works there, so it does not
 * try to sign in; it says where the pane belongs. Same plain-text layout as
 * PaneErrorFallback.
 */
export function OutsideOfficeNotice(): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium text-foreground">Open Mike in Word</p>
      <p className="text-xs text-muted-foreground">
        This page is Mike's Word add-in. It works inside Microsoft Word, from
        the Mike button on the Home tab.
      </p>
    </div>
  );
}
