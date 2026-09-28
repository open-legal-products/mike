# Mike for Mac

The complete Mac app runs Mike's frontend, backend, authentication, database,
filesystem storage and workflow catalog on the user's Mac. It targets Apple
Silicon and macOS 14 or later. End users do not install Docker, Node, Homebrew,
Postgres or Ollama.

## First use

1. Open Mike and choose **Start on this Mac**.
2. Choose **Download local AI** or **Continue without local AI**. The base app
   includes the inference runtime; model weights are a separate, explicit download.
3. Open the workspace and choose **Continue on this Mac**. This creates a
   persistent local account without a cloud signup or practice questionnaire.

The initial model is selected only when the profile has no saved model choice.
External legal research starts off for that selection, and failed local inference
has no cloud fallback. **Mike → Local AI…** reopens download controls, synthetic
measurements and the guide to a firm-owned deployment. Cloud and firm-server
connections remain available through **Change Server…**.

Read [Optional local AI](docs/local-models.md) for model sizes, hardware presets,
licenses, privacy boundaries, measurement limits and the commercial path. This
branch does not automatically train on conversations or implement training jobs.

The workspace and downloaded models persist under
`~/Library/Application Support/Mike/local/`; deleting that directory deletes local
work. LibreOffice-dependent document conversions still need LibreOffice; the app
can otherwise use chat, PDF/text reading and basic workspace functions.

## Development and packaging

Build prerequisites are Node.js 22+, Go (to build the pinned auth service), and
Apple command-line development tools. They are developer dependencies, not end-user
requirements. From the repository root:

```sh
npm ci --prefix backend
npm ci --prefix frontend
npm ci --prefix desktop
npm run local:fetch --prefix desktop
npm run local:build --prefix desktop
npm run local:stage --prefix desktop
npm run dist --prefix desktop
open desktop/dist/mac-arm64/Mike.app
```

`local:fetch` obtains the pinned service binaries and integrity-checked Ollama
runtime. `local:build` validates and bundles the workflow catalog, builds the
backend, and builds the standalone frontend with bounded-memory webpack.
`local:stage` copies production dependencies and build output into `local-stack/`.
It also includes Mike's license, source commit/archive links and pinned upstream
service notices. Ollama's notices remain beside its native runtime.
No build step downloads model weights. `dist` / `dist:local` produce a complete
**unsigned development app**, not a public consumer release.

For development without repackaging:

```sh
npm run start:local --prefix desktop
MIKE_E2E_DEV=1 npm run e2e:local --prefix desktop
```

The remote-only shell remains available with `dist:shell` and
`dist:shell:signed`. `npm start --prefix desktop -- --server-url=http://localhost:3000`
connects the development shell to an existing server.

## Verification

```sh
npm test --prefix desktop
npm run e2e:models --prefix desktop
npm run e2e:local --prefix desktop
npm run e2e:model-smoke --prefix desktop
node desktop/e2e/mike-model.e2e.mjs
```

- Portable tests cover environment isolation, catalog installation, gateway access,
  runtime integrity, download/cancel/retry and model lifecycle.
- `e2e:models` drives real Electron main/preload/pages with a fake model backend.
  It checks explicit download, recovery, measurements, export, IPC isolation,
  Dock reopening and quitting during restoration. No weights are needed.
- `e2e:local` exercises the packaged welcome and optional-model choice, continues
  without a download, then starts a disposable local stack for account creation,
  project creation, PDF upload/download, and first/returning local guest access.
- `e2e:model-smoke` is an opt-in real download/inference test. It retains its
  isolated model cache for reuse. Run only one real model suite at a time.
- `mike-model.e2e.mjs` drives the packaged app, guest login, selected local model,
  two independent synthetic extraction attempts and a real workflow tool
  roundtrip. It saves synthetic SSE evidence and records quality failures
  separately from transport success.

Artifacts and disposable data are ignored under `desktop/e2e/artifacts/`. The Mac
CI workflow runs portable tests and native onboarding. Real inference and signed
release acceptance are explicit hardware/release checks, not simulated CI claims.
See [validation results](docs/local-model-validation.md) for the measured results
and limitations on the test Mac.

## Local services and privacy

The supervisor starts Postgres, GoTrue, PostgREST, an authenticated server-only
Supabase gateway, the backend and the Next.js frontend on loopback ports
42810–42815. The managed model runtime uses 42816 and its own model directory.
Per-install credentials are generated locally; no shared placeholder key grants
gateway access. The frontend uses a same-origin API proxy with cookie sessions.
Service environments exclude the launcher's provider keys and reporting settings.
The workflow catalog ships in the app and requires no startup network request.

Documents use filesystem storage with expiring signed upload/download URLs. Local
guest credentials, service secrets, the database and logs stay in application data.
Local inference runs on the Mac. Users who explicitly enable external research,
connectors or other providers can send data to those services.

Privileged download and model management APIs are restricted to exact bundled
shell pages in the main frame. The local product receives only narrow guest-login
and ready-model conveniences; remote pages and child frames cannot manage models.

## Native shell

The shell provides a Mac menu bar, window persistence, a single-instance guard,
context menus, downloads, fenced OAuth popups and external links in the default
browser. Child popup windows do not receive the privileged preload.

| Shortcut | Action |
| --- | --- |
| ⌘N | New chat |
| ⌘1–⌘6 | Assistant, Projects, Library, Tabular Review, Workflows, History |
| ⌘, | Product settings |
| ⌘⇧, | Change server |
| ⌘⇧H | Home |

Server overrides use this order: `--server-url=<url>`, `MIKE_SERVER_URL`, saved
settings, then the hosted default. A complete build with no saved choice opens
the welcome screen. `--local` and saved local mode skip that chooser.

Automation can set `MIKE_DOWNLOAD_DIR`, `MIKE_E2E_CAPTURE_EXTERNAL` and
`MIKE_E2E_DOWNLOAD_LOG` to isolate downloads and capture external-link/download
behavior. Never point a disposable test at real user data.

## Public release: signing and notarization

A simple public download-and-run experience requires an Apple **Developer ID
Application** identity with its private key and notarization credentials. These
credentials were unavailable during this implementation; unsigned local testing
does not establish Gatekeeper acceptance.

After fetching, building and staging the complete app, configure the identity in
the keychain (or `CSC_LINK` / `CSC_KEY_PASSWORD` for CI) and provide either
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or the supported App
Store Connect notarization key variables. Keep credentials outside source control.
Then run:

```sh
npm run dist:signed --prefix desktop
codesign --verify --deep --strict --verbose=2 desktop/dist/mac-arm64/Mike.app
xcrun stapler validate desktop/dist/mac-arm64/Mike.app
spctl -a -vvv -t install desktop/dist/mac-arm64/Mike.app
```

`dist:signed` delegates to `dist:local:signed`. The config generator requires the
complete staged stack, discovers nested Mach-O binaries including the inference
runtime, and adds them to the hardened-runtime signing configuration. It produces
Apple Silicon DMG and ZIP assets and requests notarization. Preserve native dylib
symlinks while packaging: repairing a sealed application after signing would
invalidate its signature.

Before publishing, download the signed artifact onto a separate Mac and verify
first launch, model installation, offline relaunch, document/chat tasks, cancelled
download recovery and upgrades preserving local data. Auto-update and `mike://`
deep links remain follow-up work. No unsigned artifact should be presented as the
finished public release.

## Icon

The icon derives from the product's glass asterisk. Regenerate it with
`npm run icon --prefix desktop`; `assets/icon.html` is the source.
