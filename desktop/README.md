# Mike for Mac

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

Out of the box the app points at the hosted service
(`https://app.mikeoss.com`), so a downloaded build works with nothing else
installed — open it, log in, done. Self-hosters point it at their own stack
via the connect screen (⌘⇧,) or the overrides below. The connect screen also
offers a third mode: **Run locally on this Mac** — the app supervises an
entire Mike stack on loopback (see "Self-contained local mode" below), no
Docker, no server, no account anywhere.

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

By default the shell loads the hosted service. To develop against a local
frontend, start the stack per the repo README and retarget the shell (⌘⇧, or
`--server-url=`):

```bash
cd desktop
npm install
npm start -- --server-url=http://localhost:3000
```

### Overrides (automation / e2e)

Server URL precedence: `--server-url=<url>` CLI flag → `MIKE_SERVER_URL` env →
saved settings (`~/Library/Application Support/Mike/settings.json`) → default
`https://app.mikeoss.com`. The overrides let e2e retarget the packaged app
without touching the user's real settings.

| Variable                    | Effect                                          |
| --------------------------- | ----------------------------------------------- |
| `MIKE_SERVER_URL`           | server URL (overridden only by `--server-url=`) |
| `MIKE_DOWNLOAD_DIR`         | download folder instead of `~/Downloads`        |
| `MIKE_E2E_CAPTURE_EXTERNAL` | file path; would-be "open in browser" URLs are appended here instead of opening tabs |
| `MIKE_E2E_DOWNLOAD_LOG`     | file path; each finished download appends a JSONL line (`state`, `savePath`, `url`) — needed because an attached CDP automation client diverts downloads away from `setSavePath` |

## Package & test locally (no Apple account needed)

```bash
npm run dist   # → dist/mac-arm64/Mike.app (unsigned)
open dist/mac-arm64/Mike.app   # loads https://app.mikeoss.com
```

**A locally-built app runs without any Gatekeeper prompt** — the "damaged / can't
be opened" block only applies to apps *downloaded* from the internet (they get a
`com.apple.quarantine` attribute; a file you built yourself does not). So this
is the path to test the app end-to-end today, before anyone signs anything.

To point it at a stack other than the hosted default (e.g. a local
docker-compose stack), use the connect screen (⌘⇧,) or launch with an
override:

```bash
open dist/mac-arm64/Mike.app --args --server-url=http://localhost:3100
# or, without packaging:
npm start -- --server-url=http://localhost:3100
```

## Self-contained local mode

`src/local/supervisor.js` is docker-compose.yml reimplemented as a process
tree: Postgres 17 → GoTrue (its own auth migrations) → product schema +
migration ledger → PostgREST → a Node gateway proxy (the nginx
`gateway.conf` port, plus per-install anon-key injection) → the backend →
the Next standalone frontend, all loopback-only on fixed ports (42810–42815;
fixed because the frontend bakes its API origins at build time). The web app
and backend run byte-identical to the compose stack — only the process
manager differs.

Per-install secrets (JWT secret, anon/service keys, DB password, signing
secrets) are minted on first run into `userData/local/secrets.json`; nothing
secret ships in the build (the bundle carries only the well-known Supabase
demo anon key as a placeholder, which the gateway swaps for the real
per-install key — see `src/local/gateway.js`). Documents are plain files
under `userData/local/storage` (backend `STORAGE_DRIVER=fs`); downloads use
expiring HMAC blob-token URLs instead of S3 presigning. Postgres data lives
in `userData/local/pgdata`; each service logs to `userData/local/logs/`.

```bash
npm run local:fetch    # once: postgres + postgrest binaries, gotrue built from source (needs go)
npm run local:build    # backend tsc + frontend standalone (local URLs baked)
npm run start:local    # dev-mode launch straight into local mode
MIKE_E2E_DEV=1 npm run e2e:local   # fresh-userData first-run e2e, dev mode

npm run local:stage    # stage built app into local-stack/app for packaging
npm run dist:local     # package Mike.app WITH the whole stack inside (unsigned)
npm run e2e:local      # same first-run e2e against the PACKAGED app
```

On a first launch with no saved choice, a build that carries the stack shows
a welcome chooser — **Use Mike Cloud / Run everything on this Mac / connect
to your own server** — so local-first needs zero knowledge of shortcuts.
Any explicit signal (`--server-url=`, `--local`, or a previously saved
choice) skips the chooser, so automation and returning users never see it.

Known limits (deliberate v1 scope): password reset by email needs an SMTP
server, so it's unavailable in local mode (stated on the connect screen);
LLM calls still need a per-user API key (Settings → API Keys) or a local
Ollama; docx→pdf renditions activate only if LibreOffice is installed (the
supervisor auto-detects `/Applications/LibreOffice.app`) — without it the
product falls back to client-side docx preview, as designed.

## Signing & notarization (for a distributable release)

Everything above works unsigned for local use. To hand a `.dmg` to end users
without the "damaged" Gatekeeper block, the build must be **signed with a
Developer ID and notarized by Apple**. Only the org that owns the Apple Developer
account can do this — the certificate is org-held and never needs to touch a
contributor's machine. The config is already wired (`electron-builder.release.json`,
`assets/entitlements.mac.plist`); the release build is `npm run dist:signed`, which
signs and notarizes when three environment variables are present.

### One-time setup (org account holder)

1. **Apple Developer Program membership** ($99/yr) for the org.
   `developer.apple.com` → Account → enroll (as an Organization).

2. **Create a "Developer ID Application" certificate.** In Xcode:
   Settings → Accounts → (add the org Apple ID) → *Manage Certificates…* → **+**
   → **Developer ID Application**. This installs the certificate **and its
   private key** into the login keychain. (No Xcode? `developer.apple.com` →
   Certificates → **+** → *Developer ID Application*, then double-click the
   downloaded `.cer` to import — but the machine that generated the CSR must
   hold the private key.)

   Confirm it's there:
   ```bash
   security find-identity -v -p codesigning
   # → look for "Developer ID Application: <Org Name> (TEAMID)"
   ```

3. **Note the Team ID** (10 chars): `developer.apple.com` → Membership details.

4. **Create a notarization credential** — an app-specific password is simplest:
   `appleid.apple.com` → Sign-In and Security → **App-Specific Passwords** →
   generate one (label it e.g. `notarytool`). Copy the `xxxx-xxxx-xxxx-xxxx`
   value. *(For CI, prefer an App Store Connect API key instead — see below.)*

### Build a signed + notarized release

With the certificate in the keychain, set the three env vars and run the signed
build. electron-builder signs with the Developer ID cert, submits to Apple's
notary service, waits for the ticket, and **staples** it to the app:

```bash
export APPLE_ID="appleid@your-org.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"

npm run dist:signed
# → dist/Mike-<version>-arm64.dmg  and  .zip  (signed, notarized, stapled)
```

Notarization typically takes a few minutes; electron-builder blocks until Apple
returns the ticket. Verify the result:

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Mike.app"
xcrun stapler validate                          "dist/mac-arm64/Mike.app"
spctl -a -vvv -t install                        "dist/mac-arm64/Mike.app"
# the spctl line should print: source=Notarized Developer ID
```

A user who downloads that `.dmg` gets a normal double-click launch — no
"damaged" warning, no Terminal workaround.

### Doing it in CI (recommended for real releases)

So the certificate lives only as encrypted secrets and never on a laptop:

- Export the cert **with its private key** as a `.p12`
  (Keychain Access → right-click the identity → Export), base64-encode it, and
  store it as a secret (`MAC_CERT_P12_BASE64`) plus its export password
  (`MAC_CERT_PASSWORD`).
- In the workflow, decode it and either set `CSC_LINK`/`CSC_KEY_PASSWORD` (which
  electron-builder imports into a temp keychain automatically) or import it
  yourself with `security import`.
- Provide notary creds as secrets. For CI an **App Store Connect API key** is
  cleaner than an app-specific password: `developer.apple.com` → Users and
  Access → Integrations → **App Store Connect API** → generate a key with
  *Developer* access, download the `.p8` once, and set `APPLE_API_KEY` (path to
  the `.p8`), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`; electron-builder's
  `notarize` picks these up in place of the Apple-ID trio.
- Run `npm run dist:signed` and upload the `dmg`/`zip` as release assets.

> The signed path is documented and pre-wired but **can only be exercised with
> the org's certificate**, so it is not verified in this repo's CI — the unsigned
> local build and the e2e suites are.

### Signing the self-contained build (`dist:local:signed`)

The self-contained app is harder to sign than the plain shell for one
reason: **notarization requires every nested Mach-O in the bundle to carry
its own hardened-runtime signature** — that's postgres and its ~10 dylibs,
gotrue, postgrest, and any native `.node` modules in the backend's
production dependencies. electron-builder signs only the binaries it is
told about (`mac.binaries`), and the exact set changes whenever a pinned
version changes, so the config is **generated, never hand-maintained**:

```bash
# prereqs: certificate in the keychain + the three APPLE_* env vars,
# exactly as in the section above, then:
npm run local:fetch && npm run local:build && npm run local:stage
npm run dist:local:signed
# = node scripts/make-signed-local-config.mjs   (scans local-stack/ for
#     Mach-O files → writes electron-builder.release.local.json with
#     extraResources + mac.binaries filled in)
#   electron-builder --mac --config electron-builder.release.local.json
```

Verify the result the same way as the shell build, plus spot-check a nested
binary and run the packaged first-run e2e against the signed app:

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Mike.app
codesign -dv dist/mac-arm64/Mike.app/Contents/Resources/local-stack/bin/pg/bin/postgres
xcrun stapler validate dist/mac-arm64/Mike.app
spctl -a -vvv -t install dist/mac-arm64/Mike.app   # → Notarized Developer ID
npm run e2e:local                                   # full boot inside the signed app
```

Two constraints worth knowing before touching anything here:
- The dylib version-name **symlinks** in `pg/lib` must survive into the
  bundle (electron-builder preserves them; the generator skips them because
  codesign resolves links — signing a link twice fails the build). The
  supervisor re-hydrates missing links at boot from `pg-symlinks.json`, but
  a **signed** bundle is sealed: hydration writing into Resources would
  break the signature, so links must be intact at packaging time. If
  `codesign --verify` fails after a repackage, check the links first.
- The entitlements file is shared with the shell build. Postgres, Go
  binaries, and Node run fine under the hardened runtime with the existing
  entitlements; do not add `com.apple.security.cs.*` exceptions
  speculatively — notarization gets stricter about them every year.

### If you choose *not* to sign

Distributing the unsigned `.dmg` still works, it's just rougher for the
downloader: the app opens as **System Settings → Privacy & Security → "Open
Anyway"**, or from Terminal with
`xattr -dr com.apple.quarantine /Applications/Mike.app`. (macOS 15 Sequoia
removed the old Control-click → Open shortcut, so it's the Settings pane or the
`xattr` command now.) Nothing about the app is degraded — signing is purely the
download-trust gate.

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

## Needs a human / product decision

- **Signing & notarization** — config is wired (see above); needs the org's
  Apple Developer ID to actually run.
- **Release CI** — no workflow builds `desktop/` yet, so it will drift from the
  frontend unless a build+e2e job is added.
- **Auto-update** (electron-updater) — the `zip` target is already emitted for
  it; wiring it up is a follow-up decision.
- **`mike://` deep links** — the email-change confirmation link still opens in
  the browser; a protocol handler would keep it in-app.
- Native drag-out of documents, dock badge for running reviews — nice follow-ups.
