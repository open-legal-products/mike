# DOCX editor

`DocxView` uses SuperDoc for the assistant document panel, IDE document viewer,
and document side panels. There is no rendering-engine selector.

A **View / Edit** selector lets readers switch without remounting the document.
`DocxView` accepts `defaultMode` (view-only when omitted); the assistant document
panel, IDE viewer, and document side panel set `defaultMode="edit"`, showing the
native formatting toolbar above the scrollable pages initially. The reader's
mode choice lasts until the viewer closes or a different document opens.

Edits are local to the mounted editor. **Download DOCX** and Cmd/Ctrl+S export
the edited document; they do not create a Mike version or overwrite the server
file. Download before closing the viewer or switching documents. Switching
view/edit modes preserves edits. Reloading the browser with unsaved edits
triggers its leave-page warning. Existing Mike edit cards still resolve changes
through the backend and refresh the document.

## Version and behavior

`@superdoc/react` **2.12.0** pins `superdoc` **2.17.0**, which depends on
`@superdoc/docx-engine` **0.16.0**. The native toolbar fits the container, pages
fit its width, and comments use the inline layout. View-only mode shows
tracked-change markup and comments. Document-open telemetry is disabled. No
collaboration provider is configured; `yjs` and `@hocuspocus/provider` satisfy
SuperDoc's runtime peer dependencies.

The editor is AGPL-3.0, but its required DOCX engine is proprietary. See the
[DOCX Engine license](https://docs.superdoc.dev/resources/docx-engine-license/)
for deployment terms. This integration does not certify full Word fidelity:
missing or substituted fonts can change line breaks and pagination.

The production app uses the existing authenticated document fetch and shared
byte cache. Rendering happens in the browser, and the editor is loaded lazily.
Mike's citation highlights use SuperDoc's search API to reveal off-screen text;
revision highlights match imported Word revision IDs across rendered runs.

## Try the editor without backend services

From this checkout, using a supported Node runtime (verification used Node 24):

```sh
npm ci --prefix frontend
npm run catalog:docx --prefix frontend -- --host 127.0.0.1 --port 6102
```

Open <http://127.0.0.1:6102/>. The dedicated Ladle story generates a synthetic
agreement with several fonts, a table, headers, footers, a footnote, and tracked
changes. It has view/edit, narrow-panel, citation, edit-highlight, and invalid-file
controls. Its local file picker uses a browser blob URL and does not upload the
selected document. The normal primitive catalog is unchanged.

After switching to this branch, install its dependencies before starting the
app. Bun users can run `bun install --frozen-lockfile`, then `bun dev`, from
`frontend/`. Both npm and Bun lockfiles are maintained.

## Worker assets

SuperDoc's default worker paths do not resolve in npm's nested dependency
layout. `prepare:docx` copies its three published module workers and license
notices into the ignored `public/superdoc/0.16.0/` directory before dev, production
build, and the editor catalog. The adapter uses the documented `workerUrls`
configuration to serve these from Mike's origin in both Next and the catalog.

The script checks the pinned engine version and resolves packages through the
React wrapper. Upgrades must update the worker filenames and adapter URLs
together. Do not commit generated worker bundles. Direct bundler invocations
must first run `npm run prepare:docx` from `frontend/`.

## Verification

- Frontend TypeScript, lint, and a production Next build.
- Focused Vitest coverage: default renderer, mode preservation, scroll restoration,
  citation/revision highlights, refresh/error recovery, native revision optimistic
  resolution, panel integration, and import architecture.
- Headless Chromium with synthetic documents: 950px and 400px panels, typing,
  toolbar visibility in both modes, citation jumps, resizing, malformed-file
  handling, and downloads whose DOCX XML contains the edited text. These checks
  do not exercise an authenticated backend session or assert pixel parity with Word.
