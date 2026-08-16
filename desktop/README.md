# Mike for Mac (prototype)

A native macOS shell around the Mike web app — the same pattern as the Word
add-in: clients don't re-implement the product, they give the web app a
first-class home. The shell contributes the parts a browser tab can't:

- a real menu bar mirroring the sidebar (shortcuts below)
- inset traffic-light title bar, window-state persistence, single instance
- right-click context menu (copy/paste, spellcheck suggestions, link actions)
- external links open in the default browser; OAuth popups and document
  downloads are handled in-app (see below)
- a connection screen when the server is unreachable (⌘⇧, to change servers),
  instead of a Chromium error page

The web app receives **no** privileged APIs — it must behave identically in a
browser, so the shell can never fork the product.

## Shortcuts

| Shortcut | Action                          |
| -------- | ------------------------------- |
| ⌘N       | New Chat (`/assistant`)         |
| ⌘1       | Assistant                       |
| ⌘2       | Projects                        |
| ⌘3       | Library                         |
| ⌘4       | Tabular Review                  |
| ⌘5       | Workflows                       |
| ⌘6       | History                         |
| ⌘,       | Settings (product settings page)|
| ⌘⇧,      | Change Server… (connect screen) |
| ⌘⇧H      | Home                            |

⌘1–⌘5 follow the sidebar's own order; ⌘, goes to the product's settings page
per mac convention, so the shell's server picker lives on ⌘⇧,.

## Popups, OAuth, downloads

Three kinds of "leave the current page" exist, and the shell treats them
differently on purpose:

- **Script-driven popups** (`window.open("about:blank", …)`) become real
  child windows — this is how the MCP connector OAuth flow works: the app
  opens a blank popup, steers it through third-party consent pages, and the
  API-origin callback reports back via `window.opener.postMessage`. The whole
  chain stays inside the popup (bouncing any hop to the system browser would
  sever `window.opener` and strand the flow). Child windows are fenced: they
  never get the shell preload, http(s)-only navigation, and their own popups
  obey the same policy.
- **External links** (`target="_blank"` to a foreign origin) open in the
  default browser, as before.
- **Same-window navigations to a foreign origin** are probed with a 1-byte
  ranged GET: if the response says attachment/binary (the app's presigned
  document URLs), it downloads in-app to `~/Downloads` (no save dialog,
  Finder-style ` (2)` collision naming, dock bounce on completion);
  otherwise it opens in the default browser.

## Run (dev)

Needs a running Mike frontend (`http://localhost:3000` by default — start the
stack per the repo README, or point the app at a hosted deployment via ⌘⇧,).

```bash
cd desktop
npm install
npm start
```

### Overrides (automation / e2e)

Server URL precedence: `--server-url=<url>` CLI flag → `MIKE_SERVER_URL` env →
saved settings (`~/Library/Application Support/Mike/settings.json`) → default
`http://localhost:3000`. The overrides let e2e retarget the packaged app
without touching the user's real settings.

| Variable                    | Effect                                          |
| --------------------------- | ----------------------------------------------- |
| `MIKE_SERVER_URL`           | server URL (overridden only by `--server-url=`) |
| `MIKE_DOWNLOAD_DIR`         | download folder instead of `~/Downloads`        |
| `MIKE_E2E_CAPTURE_EXTERNAL` | file path; would-be "open in browser" URLs are appended here instead of opening tabs |
| `MIKE_E2E_DOWNLOAD_LOG`     | file path; each finished download appends a JSONL line (`state`, `savePath`, `url`) — needed because an attached CDP automation client diverts downloads away from `setSavePath` |

## Package

```bash
npm run dist   # → dist/mac-arm64/Mike.app (unsigned)
```

Unsigned prototype: first launch needs right-click → Open (Gatekeeper), and
distribution would need Developer ID signing + notarization.

## Icon

The dock icon is the product's own 12-blade glass asterisk
(`frontend/src/app/components/chat/mike-icon.tsx`) on a macOS Big-Sur-style
plate. `assets/icon.html` is the source of truth; regenerate with:

```bash
npm run icon   # renders via Electron's Chromium, then iconutil → icon.icns
```

## E2E

With the docker-compose stack running and the app packaged:

```bash
npm run e2e
```

Launches the **packaged** `Mike.app` (not `electron .`, so packaging
regressions fail too) with a CDP port, drives it with Playwright: asserts the
shell connects and routes an anonymous user to `/login`, signs up a fresh
user through the real UI (local stack autoconfirms), creates a project via
the wizard, and drops screenshots in `e2e/artifacts/`. Native menu items
can't be driven over CDP — menu coverage is manual.

## Not done yet (deliberate prototype cuts)

- Code signing / notarization (needs an Apple Developer identity)
- Auto-update, crash reporting
- Native drag-out of documents, dock badge for running reviews — good
  follow-ups once the shell direction is confirmed
