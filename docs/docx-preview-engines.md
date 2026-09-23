# DOCX preview comparison

`DocxView` offers a local **EigenPal / Casual Docs** toggle. The assistant's
document panel, the IDE document viewer, and document side panels share this
component. The selection lasts for the mounted viewer; it is not an account
setting. Switching engines reuses the fetched bytes and retains the scroll
offset (the same offset can show different text when pagination differs).

Both adapters are read-only. Existing Mike edit cards still resolve changes
through the backend and refresh the preview. The integrations do not save or
round-trip documents through either engine.

## Versions and limitations

- EigenPal: `@docx-editor.dev/react`, `core`, and `fonts` **2.21.1**. The default
  preview uses its packaged font resolver and fits the panel width. The free
  engine hides deleted text; the UI explains this. No Pro package or review
  license is installed. Off-screen citation matches use the engine's search
  and reveal API before applying Mike's highlight.
- Casual Docs: `@casualoffice/docs` **1.4.2**. Insertions and deletions render on
  the page. A scoped CSS adapter removes the full editor's fixed-width review
  sidebar reservation and hides its sidebar and accept/reject action bar in
  this read-only preview. Comment threads are therefore not exposed by this
  adapter. It uses its own browser font loading/fallback behavior.
- Neither adapter implements a comment editor. This comparison does not
  certify either library against the earlier full Word-editor requirements.
  Missing or substituted fonts can change line breaks and pagination. Test
  representative documents before choosing an engine.
- During browser testing, both engines compressed a table whose OOXML width
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
changes. It has narrow-panel, citation, edit-highlight, and invalid-file
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

## Verification

- Frontend TypeScript and a production Next build.
- Focused Vitest coverage: viewer switching, byte reuse, scroll restoration,
  citation/revision highlights, document refresh/error recovery, native revision
  optimistic resolution, panel integration, and import architecture.
- Headless Chromium using the real adapters: 950px and 400px panels, switching,
  fonts/footnotes, fixed-width tables, highlights after resizing, malformed-file
  handling, and recovery. These use synthetic files and do not exercise an
  authenticated backend session or assert pixel parity with Word.
