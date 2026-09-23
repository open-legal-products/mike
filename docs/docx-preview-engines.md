# DOCX preview comparison

`DocxView` offers a local **EigenPal / Casual Docs / SuperDoc** toggle. The assistant's
document panel, the IDE document viewer, and document side panels share this
component. The selection lasts for the mounted viewer; it is not an account
setting. Switching engines reuses the fetched bytes and retains the scroll
offset (the same offset can show different text when pagination differs).

All three adapters support view-only and edit modes. A **View / Edit** selector next
to the renderer selector lets readers switch without remounting the document.
`DocxView` accepts `defaultMode` (view-only when omitted); the assistant document
panel, IDE viewer, and document side panel set `defaultMode="edit"`, showing the
native formatting toolbar above the scrollable pages initially. A reader's mode
choice lasts until that document viewer is closed or a different document is opened.

Edits are local to the mounted editor. **Download DOCX** (and the editor's save
action) exports the edited document; it does not create a Mike version or
overwrite the server file. Download before closing the viewer or switching
documents. Switching rendering engines with unsaved edits requires confirmation;
switching view/edit modes preserves the current document. Reloading the browser
with unsaved edits triggers its leave-page warning. Existing Mike edit cards
still resolve changes through the backend and refresh the document.

## Versions and limitations

- EigenPal: `@docx-editor.dev/react`, `core`, and `fonts` **2.21.1**. The default
  preview uses its packaged font resolver and fits the panel width. The free
  engine hides deleted text; the UI explains this. No Pro package or review
  license is installed. Off-screen citation matches use the engine's search
  and reveal API before applying Mike's highlight.
- Casual Docs: `@casualoffice/docs` **1.4.2**. Insertions and deletions render on
  the page. A scoped CSS adapter removes the full editor's fixed-width review
  sidebar reservation and hides its sidebar and accept/reject action bar in
  this embedded viewer. Comment threads are therefore not exposed by this
  adapter. It uses its own browser font loading/fallback behavior.
- SuperDoc: `@superdoc/react` **2.12.0**, which pins `superdoc` **2.17.0** and
  `@superdoc/docx-engine` **0.16.0**. The native toolbar fits the container,
  pages fit its width, and comments use the inline layout. View-only mode shows
  tracked-change markup and comments. Mode changes preserve local edits;
  Cmd/Ctrl+S uses Mike's download action. Document-open telemetry is disabled.
  **Licensing differs:** the editor is AGPL-3.0, but its required DOCX engine
  is proprietary. This is not a fully open-source/MIT stack. See the
  [DOCX Engine license](https://docs.superdoc.dev/resources/docx-engine-license/)
  before deciding whether to ship this option in a commercial deployment.
- EigenPal and Casual Docs do not expose a comment editor in these adapters;
  SuperDoc retains its built-in comment UI. This integration does not
  certify the libraries against the earlier full Word-editor requirements.
  Missing or substituted fonts can change line breaks and pagination. Test
  representative documents before choosing an engine.
- During browser testing, EigenPal and Casual Docs compressed a table whose OOXML width
  was `w:type="pct" w:w="100%"`. The default synthetic sample uses explicit
  twip widths so other features remain easy to compare. Percentage-width
  tables should be included in further fidelity testing.

## Try the renderers without backend services

From this checkout, using a supported Node runtime (verification used Node 24):

```sh
npm ci --prefix frontend
npm run catalog:docx --prefix frontend -- --host 127.0.0.1 --port 6101
```

Open <http://127.0.0.1:6101/>. The dedicated Ladle story generates a synthetic
agreement with several fonts, a table, headers, footers, a footnote, and tracked
changes. It has view/edit, narrow-panel, citation, edit-highlight, and invalid-file
controls. Its local file picker uses a browser blob URL; it does not upload the
selected document to Mike. The normal primitive catalog is unchanged.

After switching to this branch, install its dependencies in the new checkout
before starting the app. Bun users can run `bun install --frozen-lockfile`, then
`bun dev`, from `frontend/`. The Bun lockfile is synchronized from the npm
lockfile; dependencies installed in another worktree do not follow a branch
switch.

The production app uses the existing authenticated document fetch and shared
byte cache. Rendering happens in the browser. Only the selected renderer's
JavaScript is requested initially.

## Package compatibility

Casual Docs eagerly imports its optional collaboration dependencies, so the
frontend explicitly installs `yjs`, `y-prosemirror`, `y-websocket`, and
`@hocuspocus/provider`. The preview does not create collaboration connections.

Its optional converter depends on `@schnsrw/core@0.1.1`, whose published WASM
loader points to the wrong directory. `frontend/scripts/prepare-docx.mjs`
corrects that one asset URL before dev, production build, and the comparison
catalog. It is idempotent and deliberately fails if the version or expected
loader changes. Recheck and remove this workaround when upstream fixes the
package. It resolves the converter from Casual Docs so nested dependency layouts
also work. Direct bundler invocations must first run `npm run prepare:docx` from
`frontend/`.

The comparison's Vite configuration leaves EigenPal's packages out of dependency
prebundling so its `import.meta.url` font and WASM assets resolve correctly.
Next's production build uses the normal app configuration.

SuperDoc's default worker paths do not resolve in npm's nested dependency
layout. `prepare:docx` also copies its three published module workers and
license notices into the ignored `public/superdoc/0.16.0/` directory. The adapter
uses the documented `workerUrls` configuration to serve these from Mike's
origin in both Next and the comparison catalog. The script checks the pinned
engine version and resolves packages through the React wrapper; upgrades must
update the worker filenames and adapter URLs together. Do not commit generated
worker bundles. No collaboration provider is configured.

## Verification

- Frontend TypeScript and a production Next build.
- Focused Vitest coverage: viewer switching, byte reuse, scroll restoration,
  citation/revision highlights, document refresh/error recovery, native revision
  optimistic resolution, panel integration, and import architecture.
- Headless Chromium using the real adapters: 950px and 400px panels, switching,
  fonts/footnotes, fixed-width tables, highlights after resizing, malformed-file
  handling, recovery, typing, toolbar visibility in both modes, and downloading
  DOCX files whose XML contains the edited text. These use synthetic files and do not exercise an
  authenticated backend session or assert pixel parity with Word.
- SuperDoc additionally checked through the production Next server using a
  temporary local-only test page (removed afterward): typing, mode preservation,
  DOCX download, citation jumps, resizing, and malformed-file handling.
