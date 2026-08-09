# Mike for Mac (prototype)

A native macOS shell around the Mike web app — the same pattern as the Word
add-in: clients don't re-implement the product, they give the web app a
first-class home. The shell contributes the parts a browser tab can't:

- a real menu bar (⌘N new chat, ⌘P projects, ⌘L library, ⌘K workflows)
- inset traffic-light title bar, window-state persistence, single instance
- external links open in the default browser (only the configured Mike
  server's origin renders inside the app — OAuth consent, cited sources and
  docs go to the real browser)
- a connection screen when the server is unreachable (⌘, to change servers),
  instead of a Chromium error page

The web app receives **no** privileged APIs — it must behave identically in a
browser, so the shell can never fork the product.

## Run (dev)

Needs a running Mike frontend (`http://localhost:3000` by default — start the
stack per the repo README, or point the app at a hosted deployment via ⌘,).

```bash
cd desktop
npm install
npm start
```

## Package

```bash
npm run dist   # → dist/mac-arm64/Mike.app (unsigned)
```

Unsigned prototype: first launch needs right-click → Open (Gatekeeper), and
distribution would need Developer ID signing + notarization.

## Not done yet (deliberate prototype cuts)

- App icon (default Electron icon for now)
- Code signing / notarization (needs an Apple Developer identity)
- Auto-update, crash reporting
- Native drag-out of documents, dock badge for running reviews — good
  follow-ups once the shell direction is confirmed
