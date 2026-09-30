# DOCX editor

`DocxView` uses EigenPal for the assistant document panel, IDE document viewer,
and document side panels. There is no rendering-engine selector. The formatting
toolbar starts hidden in the assistant side panel and visible in the IDE.
The title-row **Edit** button controls editing and toolbar visibility in both
surfaces, with darker text while active. When off, EigenPal enforces read-only
mode: typing, pasting, formatting, and native review mutations are locked.
The assistant starts locked; the IDE starts with Edit active for users who may
replace that document version. The document detail API supplies `can_edit` and
`can_delete` using the same rules as the write endpoints. Viewers fail closed
while permissions load, and shared-chat readers cannot enable editing. Resolved
rights stay cached per document while tabs change; disabling access clears them.
Project tabs and viewers share the same permission lookup. Toggling keeps
the mounted editor, unsaved changes, and undo history. Each panel retains its
choice when switching tabs or annotations. While Edit is active, EigenPal's
native mode picker offers Viewing, Editing, and Suggesting modes.
The assistant side panel and IDE viewer share a compact file title row with
12px regular text, a 14px icon, Download, and plain-text autosave status. Both
surfaces share `DocumentContent`: the title row, citation quotes, edit cards,
loading and error states, and the file-type viewer. Both retain each tab's
citation/edit context until dismissed and support case-law sources and
spreadsheet cell citations. Title actions collapse to icons below 600px.
Citation quotes and proposed-edit cards float at the bottom of the canvas above
the zoom/page controls, up to 64rem wide, with bounded height and their own scrolling. The shared annotation
layer measures the card and keeps selected passages/changes in the unobscured
area, adds scroll room after the final page, and stops automatic repositioning
when the reader scrolls or interacts with the document. DOCX uses EigenPal's
native selection geometry; PDF/case highlights and spreadsheet cell focus use
the same available canvas space. Off-screen tracked edits are revealed through
the editor's review model by OOXML revision ID, so repeated wording on earlier
pages cannot redirect navigation to an unrelated passage.

Each document has one tab. The flat version-and-chevron control in its title
row opens a version menu when multiple non-deleted versions exist; a single
version stays a plain label. Choosing an entry replaces that tab's preview without
changing the server's active version. Switching versions clears the previous
version's citation/edit section. The control waits for pending DOCX autosaves
before allowing a switch. The shared tab bar supports inline rename, context
actions, keyboard navigation and reordering. DOCX retains its native formatting toolbar.
The document side-panel canvas has no title bar. Tabs have a transparent strip and inactive tabs, with
a rounded, light-grey active tab. Right-click a viewer or assistant document tab for the
explorer’s Add to chat, Download, Rename, and Delete file actions. Rename
edits the tab label in place (Enter or blur to save, Escape to cancel).

`DocxView` accepts `defaultMode` (view-only when omitted). The assistant document
panel, IDE viewer, and document side panel set `defaultMode="edit"`. This is an
initial mode: parent rerenders do not override the reader's native toolbar
choice while Edit is active. Turning Edit off overrides it with read-only mode;
turning it on returns to the initial mode. Opening another document or version
creates a new editor.

Open **… → Navigation pane** to show or hide the document outline and search.
The action shares EigenPal's overflow menu; a More menu remains available when
all formatting controls fit. The navigation pane has a 12px left inset.

Edits autosave to the open stored version after a short pause (1.5 seconds).
Closing a tab/panel or switching its version waits for pending saves. If saving
fails, the viewer stays mounted and asks whether to keep editing or discard
unsaved changes. Conflicts require downloading a copy or explicitly discarding;
closing does not retry a known conflict. Browser unload still warns about dirty
or in-flight edits.

Project file deletion asks for confirmation, including discarding unsaved edits,
and checks the document's current delete permission again before the request.
Cancellation or failure preserves the viewer and draft. Successful deletion
disables that viewer's pending/unmount autosave before removing its tab.

Tracked-change accept/reject uploads to a new storage object, then conditionally
swaps the version's path, hash, size and PDF rendition in one database update.
A competing editor save or review action receives a conflict instead of losing
either writer's content. The lifecycle cleanup retires the old objects.
Tracked edits and review decisions use that same save path. Autosave does not
generate a PDF; it invalidates the previous PDF rendition. Content hashes protect
against overwriting another editor's newer file. **Download** exports the live
document, and **Ctrl/Cmd+S** requests an immediate save. Standalone previews using
`displayUrl`, including the catalog story, only export locally. Native mode
switching preserves edits. A fresh server snapshot replaces a clean editor and
resets its save baseline; pending edits, in-flight saves, and refreshes of the
editor's own saved bytes retain the current editor and undo history. Reads that
span a local edit or save cannot replace it with stale content. Reloading with unsaved edits triggers a leave-page
warning. Existing Mike edit cards still resolve through the backend.

## Version and behavior

`@docx-editor.dev/react`, `@docx-editor.dev/core`, and
`@docx-editor.dev/fonts` are pinned to **2.21.1**. The editor uses packaged,
metric-compatible fonts and fits the page width to the panel. Rendering happens
in the browser; the existing authenticated document fetch and shared byte cache
supply the file. The editor is loaded lazily. Failed font loads show a dismissible warning while
keeping the document and unsaved edits available; parse/load failures remain
fatal.

This installation uses only EigenPal's open-source packages. Mike registers
`docxReviewModule` through the public `EditorModule` contract. It composes
`collectReviewItems` and `revisionItemsOf` exported by the Apache-2.0 core's
`/store` entry point; the paragraph callback includes only decisions wholly
inside that paragraph. No commercial package was inspected, copied, installed,
or imported for this implementation, and no dependency files are patched.

Choose **Suggesting** in the native mode menu to record edits as DOCX revisions.
New edits use the signed-in profile's display name (email, then user ID, as
fallbacks). Standalone previews can supply an explicit `author`; without an
author, the core keeps suggesting unavailable. Existing revision authors and
dates remain intact. The core owns edit semantics, protection checks, history,
and WordprocessingML serialization, including `w:ins` and `w:del`.

The native **Comments** button shows or hides a comments column docked to the
right of the document viewport, mirroring the navigation pane on the left. The
column lists comment threads as bubbles in document order and scrolls
independently of the pages; the thread for the comment selected in the document
is scrolled into view. The page refits to the remaining width, and narrow views
can scroll horizontally. There is no tracked-changes panel. Suggesting and
inline revision markup remain available.

The review components read the mutable editor facade during render, so they opt
out of React Compiler with `"use no memo"`; otherwise pane toggles and comment
edits would render stale cached values.

To add a comment, select document text and choose **New comment** in the toolbar.
The composer opens directly below the selected passage and scrolls with it; if
the selection is not painted (a virtualized page), it opens beside the toolbar
button instead. Mike retains that selection while the composer has focus and uses the signed-in
author. The composer uses a flat grey field without a selected-text preview. **Add comment** (or
Cmd/Ctrl+Enter) writes through the public core's `addComment`; its
document-change event feeds the existing autosave pipeline without PDF
conversion. A failed write retains the draft, and changing the selection
prevents posting to a different passage. Cancel or dismissing the popup releases
the retained selection. Comment text is rendered as plain text. Viewing mode and
missing authors disable creation.

Each bubble shows its author with a **⋯** menu (Edit, Delete) on every comment
and reply, and ends with a **Reply** button. Clicking a bubble scrolls the
document to its comment. Right-clicking a bubble opens Reply, Edit and Delete.
Right-clicking a comment highlight in the document opens **View comment**, which
opens the column and focuses that bubble, and Delete. Highlights carry no comment identity, so
Mike waits for the engine to activate the comment under the pressed caret and
only opens the menu when the pointer lies on that active highlight. Right-click
tracked text to accept or reject that exact revision decision; matching uses
revision ID, author, date, and document part rather than the caret or text.
These actions use the public core review commands, preserving undo and
triggering the existing autosave. Unsupported or read-only actions are
disabled. Failed replies and edits retain the draft.

The public core cannot change a comment's text, so **Edit** writes a replacement
(same anchor, author and resolved state) and then deletes the original. It is
offered only for the signed-in author's own comment with nothing after it in its
thread — a root comment without replies or the last reply — so other
participants' dates and thread order are never rewritten. The edited comment
takes a new date.
Resolving comment threads is not implemented.

This is not a claim of full Word review or rendering parity. Edit operations and
revision kinds remain bounded by the installed core's capabilities; substituted
fonts and unsupported formatting can change line breaks and pagination. Keep
the review tests when upgrading the editor packages, since this integration
depends on their public module and store exports.

Mike's citation highlights use the native search and reveal API for off-screen
text. Tracked changes activate the matching native review item by revision ID.
EigenPal owns the revision highlight, scrolling, and repainting. If the insertion
and deletion belong to separate review items, a native text selection spans both
parts, including the unchanged text between them. Dismissing Mike's edit card
clears its highlight while preserving a subsequent user selection or activation.

## Try the editor without backend services

From this checkout, using a supported Node runtime (verification used Node 24):

```sh
npm ci --prefix frontend
npm run catalog:docx --prefix frontend -- --host 127.0.0.1 --port 6102
```

Open <http://127.0.0.1:6102/>. The dedicated Ladle story generates a synthetic
agreement with several fonts, a table, headers, footers, a footnote, and tracked
changes. It includes narrow-panel, citation, edit-highlight, and invalid-file
controls. Change viewing/editing/suggesting mode with the native toolbar. The local
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
