/// <reference types="office-js" />
import { createRoot } from "react-dom/client";
import App from "./App";
import { notifyError } from "./lib/notify";
import { ToastViewportUI } from "@mike/toast-ui";
import "./styles.css";
import {
  ErrorBoundary,
  initAddinErrorReporting,
  reportError,
  tagOfficeHost,
} from "./lib/errorReporting";
import { PaneErrorFallback } from "./components/shell/PaneErrorFallback";

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

Office.onReady(() => {
  tagOfficeHost();
  const container = document.getElementById("root");
  if (!container) {
    const missingRoot = new Error("Root element #root not found in DOM");
    reportError(missingRoot, { level: "fatal", tags: { component: "boot" } });
    throw missingRoot;
  }
  const root = createRoot(container);
  root.render(
    // `@container` makes the whole pane a query container so descendants can
    // adapt spacing/type to the (resizable, usually narrow) task-pane width
    // via `@sm:`/`@md:` variants — viewport breakpoints never fire in a pane.
    <div className="@container h-full w-full bg-background text-foreground font-sans antialiased">
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
        position="bottom-center"
        className="w-full max-w-[min(96vw,380px)] px-2"
      />
    </div>
  );
});
