/// <reference types="office-js" />
import { createRoot } from "react-dom/client";
import App from "./App";
import { notifyError } from "./lib/notify";
import { ToastViewportUI } from "@mike/ui";
import "./styles.css";
import {
  ErrorBoundary,
  initAddinErrorReporting,
  reportError,
  reportHostlessOfficeClient,
  tagOfficeHost,
} from "./lib/errorReporting";
import { PaneErrorFallback } from "./components/shell/PaneErrorFallback";
import { OutsideOfficeNotice } from "./components/shell/OutsideOfficeNotice";

// Before Office.onReady: an error while Office.js itself boots the pane is
// still an error we want to hear about.
initAddinErrorReporting("taskpane");

// A rejected promise nobody awaited used to vanish into the WebView console,
// which a user in Word cannot open. Sentry hears about it through its own
// global handler; this is the user's side of it — one deduped toast, because
// one broken poll can reject on every tick.
window.addEventListener("unhandledrejection", (event) => {
  notifyError(event.reason, {
    action: "complete that action",
    dedupeKey: "unhandled",
  });
});

// `@container` makes the whole pane a query container so descendants can
// adapt spacing/type to the (resizable, usually narrow) task-pane width via
// `@sm:`/`@md:` variants — viewport breakpoints never fire in a pane.
const PANE_CLASS =
  "@container h-full w-full bg-background text-foreground font-sans antialiased";

Office.onReady((info) => {
  tagOfficeHost();
  const container = document.getElementById("root");
  if (!container) {
    const missingRoot = new Error("Root element #root not found in DOM");
    reportError(missingRoot, { level: "fatal", tags: { component: "boot" } });
    throw missingRoot;
  }
  const root = createRoot(container);
  // Office.js resolves onReady outside Office too, with no host. There is no
  // document to work on and no Office storage, so mounting the app there only
  // produced "Something went wrong" and two Sentry faults (MIKE-WORD-ADDIN-6
  // and -7, mostly crawlers and link previews opening the page).
  if (info.host == null) {
    // Crawlers stay silent; a real Office client that resolved without a
    // host does not (see reportHostlessOfficeClient).
    reportHostlessOfficeClient();
    root.render(
      <div className={PANE_CLASS}>
        <OutsideOfficeNotice />
      </div>
    );
    return;
  }
  root.render(
    <div className={PANE_CLASS}>
      <ErrorBoundary
        fallback={({ resetError }) => (
          <PaneErrorFallback resetError={resetError} />
        )}
      >
        <App />
      </ErrorBoundary>
      {/* Mounted beside App, not inside it: App returns early while the
          session loads and on the login screen, and a failure there still
          needs somewhere to appear. Outside the boundary so a render crash
          does not take the notifications with it. The pane is ~320px wide,
          so the shared viewport's 460px cap is tightened to fit. */}
      <ToastViewportUI
        className="w-full max-w-[min(96vw,380px)] px-2"
      />
    </div>
  );
});
