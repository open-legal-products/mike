# DOCX editor

`DocxView` uses EigenPal for the assistant document panel, IDE document viewer,
and document side panels. There is no rendering-engine selector or Mike
View/Edit toggle. EigenPal's native toolbar owns mode switching and remains
visible in Viewing mode so readers can return to Editing without reopening the
file. EigenPal’s title row is hidden. The IDE viewer adds Mike’s compact file
title, icon, and Download button above every file type, with the native formatting
toolbar below for DOCX. IDE tabs have a transparent strip and inactive tabs, with
a rounded, light-grey active tab. Right-click a viewer or assistant document tab for the
explorer’s Add to chat, Download, Rename, and Delete file actions. Rename
edits the tab label in place (Enter or blur to save, Escape to cancel).

`DocxView` accepts `defaultMode` (view-only when omitted). The assistant document
panel, IDE viewer, and document side panel set `defaultMode="edit"`. This is an
initial mode: parent rerenders do not override the reader's native toolbar
choice. Opening another document or version creates a new editor.

Edits are local to the mounted editor. **Download** in an open tab’s context
menu and **Ctrl/Cmd+S** inside the editor export the edited document; they do not
create a Mike version or overwrite the server file. Download before closing the viewer or switching documents.
Native mode switching preserves edits. Reloading the browser with unsaved edits
triggers its leave-page warning. Existing Mike edit cards still resolve changes
through the backend and refresh the document.

## Version and behavior

`@docx-editor.dev/react`, `@docx-editor.dev/core`, and
`@docx-editor.dev/fonts` are pinned to **2.21.1**. The editor uses packaged,
metric-compatible fonts and fits the page width to the panel. Rendering happens
in the browser; the existing authenticated document fetch and shared byte cache
supply the file. The editor is loaded lazily.

This installation uses EigenPal's free packages. Deleted text is hidden, and
advanced review features require its Pro module; no Pro module or review license
is installed. This integration does not certify full Word fidelity: substituted
fonts and unsupported formatting can change line breaks and pagination.

Mike's citation highlights use the native search and reveal API for off-screen
text. Revision highlights match native revision IDs across rendered runs.

## Try the editor without backend services

From this checkout, using a supported Node runtime (verification used Node 24):

```sh
npm ci --prefix frontend
npm run catalog:docx --prefix frontend -- --host 127.0.0.1 --port 6102
```

Open <http://127.0.0.1:6102/>. The dedicated Ladle story generates a synthetic
agreement with several fonts, a table, headers, footers, a footnote, and tracked
changes. It includes narrow-panel, citation, edit-highlight, and invalid-file
controls. Change viewing/editing mode with the editor's native toolbar. The local
file picker uses a browser blob URL and does not upload the selected document.
The normal primitive catalog is unchanged.

After switching to this branch, install dependencies before starting the app.
Bun users can run `bun install --frozen-lockfile`, then `bun dev`, from
`frontend/`. Both npm and Bun lockfiles are maintained. No DOCX preparation script
or copied worker bundle is needed. The standalone catalog excludes EigenPal's
packages from dependency prebundling to preserve relative font and WASM assets.

## Verification

- Frontend TypeScript, lint, and a production Next build.
- Focused Vitest coverage: initial renderer/mode, scroll restoration,
  citation/revision highlights, refresh/error recovery, native revision optimistic
  resolution, panel integration, and import architecture.
- Headless Chromium with synthetic documents: native mode switching, typing,
  local edit preservation, downloading, citation jumps, resizing, and malformed
  files. These checks do not exercise an authenticated backend session or assert
  pixel parity with Word.
