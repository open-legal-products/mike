/**
 * The one way out of the task-pane webview.
 *
 * `window.open` and plain link navigation are blocked in desktop Word, where
 * they silently do nothing — the user clicks "Contact support" and the pane
 * just sits there. Office's `openBrowserWindow` is the sanctioned escape
 * hatch; `window.open` is the fallback for hosts that lack it (the hermetic
 * e2e bundle, older hosts, the pane running in a plain browser).
 *
 * Returns whether the URL was handed to something that can display it, so
 * callers can fall back further (a `mailto:`, say) instead of assuming.
 */
export function openExternalUrl(url: string): boolean {
  // This optional bridge also runs in plain browsers and Node-based tests.
  // Keep its structural type local instead of requiring the entire Office SDK.
  const host = globalThis as typeof globalThis & {
    Office?: { context?: { ui?: { openBrowserWindow?: (url: string) => void } } };
  };
  const ui = host.Office?.context?.ui;
  // The bridge supports only http(s): a `mailto:` there is a silent no-op
  // that would still read as success.
  if (/^https?:/i.test(url) && ui && typeof ui.openBrowserWindow === "function") {
    try {
      ui.openBrowserWindow(url);
      return true;
    } catch {
      // Some hosts throw instead of no-opping; try the browser path below.
    }
  }
  try {
    // No `noopener` feature: with it `window.open` returns null even when the
    // page opened, hiding the outcome. The opener is severed by hand instead,
    // before the new page can load and reach back into the pane.
    const opened = window.open(url, "_blank");
    if (!opened) return false;
    opened.opener = null;
    return true;
  } catch {
    return false;
  }
}

/** The web app this pane belongs to, without a trailing slash. */
export const WEB_APP_URL: string = (
  // Read the substituted value directly: a `typeof process` guard is false
  // in the browser and would silently select the default.
  process.env.REACT_APP_WEB_APP_URL || "https://app.mikeoss.com"
).replace(/\/+$/, "");
