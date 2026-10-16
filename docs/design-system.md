# Design system

Mike uses Tailwind v4 with shadcn-derived `new-york` primitives for selected
controls, alongside its own liquid-glass component system. Lucide supplies the
icon set. This page documents what already exists so contributors can reuse it
instead of re-deriving it. It is a description of the current system, not a
proposal for a new one.

Everything below lives in `frontend/src/app/globals.css` unless stated otherwise.

## Where components live

| Location | What belongs there |
| --- | --- |
| `frontend/src/app/components/ui/` | Shared web primitives. Small, unopinionated, no data fetching, no feature knowledge. |
| `frontend/src/shared/ui/` | Primitives shared by the web app **and** the Word add-in. Framework-light: React, `lucide-react`, `clsx`, `tailwind-merge` only. |
| `frontend/src/app/components/shared/` | App-level building blocks that assume the app shell — the table layer (`TablePrimitive.tsx`, `TableToolbar.tsx`), page headers, sidebars. |
| `frontend/src/app/components/<feature>/` | Feature components. Compose the above; do not restate their markup. |

`src/shared/ui/` may not import from `src/app/`. It is compiled into the add-in
build, which has no Next.js app directory. When you add a file there you must
also register it for Tailwind class scanning in
`word-addin/src/taskpane/styles.css`:

```css
@source "../../../frontend/src/shared/ui/YourThingUI.tsx";
```

Cross-target primitives use the `XxxUI.tsx` convention and are imported
directly from `@/shared/ui/XxxUI` by the web app. Do not add a web-only
re-export whose only job is to rename `XxxUI`: it adds another file, test, and
catalog entry without adding behavior. The dropdown is the one file named
without the suffix: `@/shared/ui/dropdown`. `GlassCardUI`, `PillButtonUI`,
`GlassIconButtonUI`, `TabPillButtonUI`, and `ToggleSwitchUI` are the canonical
implementations used by both targets. To style a link as a pill, apply
`pillButtonUIClassName` from `PillButtonUI.styles` directly to the link; this
keeps the correct link semantics and is safe in server components.

## Icons

Use the existing skeuomorphic feature, folder, file-type, and legal-source
icons where available; use Lucide for other controls. Web SVG assets render
through `components/ui/svg-asset-icon.tsx` with static imports from
`frontend/public/icons/`. Static imports produce content-hashed URLs that can
be cached immutably; avoid literal `/icons/...` URLs and manual version queries
for these assets. Small UI icons load eagerly so they appear with their labels.
The app layout preloads navigation and account-menu icons during the loading
screen, before opening a menu can trigger an image request.
`frontend/public/_headers` preserves immutable caching for `/_next/static/*`
on Cloudflare, whose asset server otherwise revalidates even hashed files.

## Color tokens

Two families coexist. Prefer a token over a raw Tailwind palette class whenever
one exists; prefer either over a hex literal.

Both families, and their `@theme inline` utility mappings, are declared once in
`frontend/src/shared/ui/DesignTokensUI.css`. The web app's `globals.css` and the
Word add-in's `word-addin/src/taskpane/styles.css` both import that file, so a
token change reaches both targets. Do not redeclare one of these tokens in either
entry stylesheet; `DesignTokensUI.test.ts` fails if you do.

### App surfaces (Mike's own)

These back the "liquid glass" chrome and are the ones most feature code needs.

| Token | Utility | Light value | Intent |
| --- | --- | --- | --- |
| `--app-background` | `bg-app-background` | `#f9fafb` | Page canvas behind panels. |
| `--app-surface` | `bg-app-surface` | `#fdfdfe` | Resting surface of a panel, table header, menu. |
| `--app-surface-hover` | `hover:bg-app-surface-hover` | `#f9fafb` | Row/item hover. |
| `--app-surface-active` | `bg-app-surface-active` | `#eff0f3` | Selected or pressed row/item. |
| `--app-floating` | `bg-app-floating` | `#fefefe` | Detached floating elements above a surface. |

Use the class-name constants in `components/ui/liquid-surface.ts` rather than
retyping the utilities. Liquid-glass controls use
`LIQUID_GLASS_HOVER_CLASS`/`LIQUID_GLASS_SELECTED_CLASS`; modal rows use the
modal-specific pair documented under elevation below.

### Component color roles

Theme-sensitive colors that do not describe elevation live in
`frontend/src/shared/ui/ThemeTokensUI.css`. This includes document tabs,
workflow-editor prose and tables, document/citation highlights, dropdown hover
and selected states, chat fades and shimmers, and spreadsheet canvas overlays.
The file is imported by both the web app and Word add-in and provides light and
`.dark` values.

Dropdown primitives use `theme-dropdown-item` and
`theme-dropdown-selected`. They consume the same general liquid-glass hover
and selected color tokens as the liquid-glass state classes, so menu and
surface interactions remain visually consistent without copied palette
utilities. Text inputs and search fields inside `theme-dropdown-surface` use
a flat grey fill with no glass shadow or blur, retaining their keyboard focus
rings. The treatment applies to dropdowns and submenus in both web and add-in.

### shadcn semantic tokens

The standard shadcn set is present and wired through `@theme inline`:
`background`/`foreground`, `card`, `popover`, `primary`, `secondary`, `muted`,
`accent`, `destructive`, `border`, `input`, `ring`, the `sidebar-*` family, and
`chart-1`…`chart-5`. Values are `oklch()`; a `.dark` block overrides them.

Use these when you pull a component from the shadcn registry, or when you want
the meaning ("this is the destructive action") rather than a specific color.

### Blue is overridden

`@theme inline` redefines part of Tailwind's blue scale to Mike's azure:

```css
--color-blue:     rgb(0, 136, 255);
--color-blue-50:  rgba(0, 136, 255, 0.05);
--color-blue-100: rgba(0, 136, 255, 0.1);
--color-blue-200: rgba(0, 136, 255, 0.3);
--color-blue-600: rgb(0, 136, 255);
--color-blue-700: rgb(0, 120, 230);
```

`bg-blue-600` is therefore Mike azure, not Tailwind blue. `blue-300`, `-400`,
`-500`, `-800` and `-900` are *not* overridden, so the scale is discontinuous —
stay on the overridden steps for brand blue.

### Dark mode

`@custom-variant dark (&:is(.dark *))` — class-based, not
`prefers-color-scheme`. The shadcn tokens, `--app-*` surface tokens, and shared
liquid-glass material tokens all have `.dark` values. The user preference adds
`.dark` to the document root, so semantic surface and material classes switch
without component-level `dark:` shadow recipes. The preference lives in
Settings > Appearance.

`MikeIcon` is the exception: the mark is inline SVG, so no class-based
remapping reaches its gradient stops. It subscribes to the document theme class
itself and swaps its dark-glass blades for the white ones. Anything else drawing
brand-colored SVG should follow the same pattern rather than hard-coding a
single palette.

### User avatars

`components/ui/user-avatar.tsx` renders profile photos and the monogram fallback
for the account button, People/share rows, member pickers, organization members,
and audit-log identities. Pass the identity's email, display name, and
`profile_photo` from the existing authorized roster response. Table avatars use
`size="sm"`: 16px across with 8px white serif initials. Pickers and detail views
use the default 20px size. Loading placeholders match the table's 16px size.
The background colour is stable and keyed to the
normalized email, falling back to the display name. A missing or
unreadable image restores those initials.

The general email lookup returns only identity fields. New direct-share
recipients show a monogram until their photo is available through an authorized
roster response; organization pickers can use their existing member photos.
Audit logs resolve photos only for actors on the authorized organization page;
personal activity and CSV exports do not fetch photos. Affected members and
invitation recipients prefer their current display name, falling back to the
recorded email, which also keeps their monogram color stable. These lookups
fetch names only for affected people on the authorized page. The Performed by
filter searches distinct actors from the organization audit log, including
former members, in a scrollable list of 20 people per page. Selecting a person
filters by their ID and preserves that filter in CSV exports.

Settings > Profile offers upload and a blue Edit button for saved images. Profile photos
and organization logos share `ImageCropModal`: both support dragging, keyboard
positioning, zoom, preview, and explicit saving. Edit reopens the saved image.
The footer places blue Save on the right and red Remove on the left.
Save stays disabled until the image or framing changes.
Photos use a circular preview
and a crop that fills it. PNG, JPEG, and WebP source files up to 10 MB are
rendered to a 256px PNG before upload; the API limits stored images to 512 KB.

## Typography

Both faces are loaded with `next/font/google` in `frontend/src/app/layout.tsx`
and exposed as CSS variables on `<body>`:

| Face | Variable | Utility | Used for |
| --- | --- | --- | --- |
| Inter | `--font-inter` → `--font-sans` | `font-sans` (body default) | All UI text. |
| EB Garamond | `--font-eb-garamond` → `--font-serif` | `font-serif` | Display headings, legal document body copy, tracked-change cards. |

The Word add-in supplies the same two variables from
`word-addin/src/taskpane/styles.css` (fonts loaded via `<link>` in
`index.html`), so `shared/ui` components render identically in both targets.

De facto type scale in the app chrome, most to least common: `text-xs` (dense
table and control text — the default for most chrome), `text-sm` (body copy,
normal-size buttons), `text-[10px]` (badges, superscript citations),
`text-2xl font-serif` (display headings and empty states), `text-xl font-serif`
(page titles and breadcrumbs). There is no separate heading component; use
`EmptyState` for empty-state headings and `PageHeader` for page titles so the
display style stays in one place. A plain page title is an `<h1>` passed as
`PageHeader`'s children with `PAGE_HEADER_TITLE_CLASS` (from
`shared/pageHeaderStyles.ts`), which is also what its breadcrumbs use. `PAGE_HEADER_ROW_CLASS` is what
keeps that title on the line of the sidebar's logo text. The settings areas
(`SettingsShell`) have a larger display title of their own, `text-3xl`.

## Spacing and radius

There is no bespoke spacing scale — Tailwind's default applies. The de facto
subset actually in use across `frontend/src/app/components`, by frequency:

- Horizontal padding: `px-3` (dominant), `px-2`, `px-4`, `px-2.5`
- Vertical padding: `py-2` (dominant), `py-1.5`, `py-1`, `py-0.5`
- Gaps: `gap-2`, `gap-1.5`, `gap-1`, `gap-3`
- Control heights: `h-7` (compact chrome: pills, icon buttons, table rows are
  `h-10`), `h-8`, `h-9`, `h-10`

Stick to those steps. A one-off `px-[13px]` is the kind of drift this document
exists to prevent.

Radius comes from one token, `--radius: 0.625rem`, with the shadcn scale derived
from it (`--radius-sm/-md/-lg/-xl` = `radius -4px / -2px / radius / +4px`). In
practice the app uses the plain Tailwind radii directly: `rounded-full` (pills,
icon buttons), `rounded-lg`/`rounded-md` (rows, list items), `rounded-xl`
(inputs, cards), `rounded-2xl` (panels, dropdown surfaces).

### Fit content before making a card compact

Account identity, permission level, and action controls must remain readable at
ordinary lengths. For example, `alex.morgan@example.com` and `Read-only` should
both be visible without a tooltip, opening a dialog, or horizontal scrolling.

- Give independent information its own line: service name, account email, then
  permission/status. Do not concatenate everything into one truncated subtitle.
- Use `min-w-0` on flexible children and `[overflow-wrap:anywhere]` for long
  unbroken identifiers. Prefer natural wrapping and card growth to ellipsis,
  clipping, smaller text, or fixed heights. Do not use `overflow-hidden` to hide
  a layout defect.
- Let action controls wrap and choose columns using the available container
  width, including space consumed by application sidebars. Viewport width alone
  does not describe a card's actual space.
- A shared minimum height can align short cards and loading states; it must not
  prevent longer content from increasing the height. Loading, connected, empty,
  and error states use the same outer layout.
- Verify realistic emails and deliberately long addresses at mobile, tablet,
  and desktop widths in light and dark mode. Check the text nodes as well as
  the outer card: a card can fit while its subtitle silently clips.

Truncation is appropriate only when the omitted text is genuinely secondary and
the user has an accessible way to inspect it. Account identity and permissions
in connector cards are essential information.

### Side-by-side chats

The Assistant and the IDE can each show two chats at once (`?side=<chatId>` in
the URL; see `useChatRoute`). Both keep their widths honest by shrinking the
neighbours, never by clipping content:

- **Assistant.** The two chat columns share the page and are split by a
  hairline (`AssistantChatDivider`) that drags or moves with the arrow keys.
  The document side panel reserves 400px for each chat and opens at two
  fifths of the page beside two chats rather than at half.
- **IDE.** The document view takes what the explorer and chat panels leave and
  never less than 320px. `app/lib/workspacePanelWidths.ts` owns that maths;
  route every new resizable panel through it rather than clamping inline.
- In the Assistant the second chat needs a wide page: below `md` only the
  primary chat renders, at full width, and the action that opens the side
  chat is not offered. The IDE is a desktop workspace and has no such gate.

The IDE's Open project picker and project switcher list projects in the active
workspace that the user created or was directly added to, whether public or
private. Public visibility alone does not make someone a participant. Switching
workspace clears the picker cache and selection. Inherited organization permissions and
audited private-content access do not put projects in this picker. The backend
applies this participation filter to its already-authorized project list.
The picker and FileDirectory share the compact native `SelectionCheckbox` in
`components/ui/selection-checkbox.tsx`, including its mixed and disabled states.

The app sidebar's History combines assistant chats and tabular reviews from
the active workspace, including reviews inside projects. Both sources are
fetched by last update and merged newest first. Older rows stay buffered until
both paginated sources reach them, so fetching another page does not reveal
newer items below older ones. Review rows use the tabular-review SVG icon and
open the review's project or standalone route. Project reviews prefix their
title with the project name. Project prefixes and chat Shared labels use the
same muted `text-gray-400` treatment. Edits and generation starts/completions
advance review activity and promote it in History; lease heartbeats do not.
Running reviews show a spinner, including after navigating away. A review
that finishes successfully while elsewhere shows a tick using the Excel SVG's
green gradient until
opened, matching unread chat completion. Failed, stopped, and incomplete
reviews do not get the completion icon. Status polling reads small authorized
snapshots only for running reviews; it never downloads their documents.
Activity refreshes keep the loaded History rows and pagination visible; only
the affected review's icon changes. A workspace change still clears the old list.
Review overview project filters, create choices and move destinations also stay
within their workspace; selecting a project filter must not disable workspace
scoping. A workspace switch resets those filters and dialogs. Detail pages opened
by link follow the item's own workspace, with project children inheriting theirs.
Late list pages and chat creations must not populate a newly selected workspace.
Chat Share, Rename and Delete actions are visible only to owners. Directly shared
standalone chats offer Leave to viewers and editors; project chats never offer
Leave because their access comes from project membership. Audited organization
access is not a direct sharing grant and does not offer Leave.
When opening a chat, missing workspace metadata means the detail is still loading;
only an explicit null organization means Personal. Prefer the matching chat detail
over a lightweight History row for workspace and attachment scope.

## Elevation and the glass surface

The signature surface combines a light fill, hairline border, inset highlight
shadows, and soft elevation. Each liquid-glass class owns all three material
properties—background, border, and shadow—through light/dark CSS variables in
`LiquidGlassUI.css`; components should not repeat a surface border utility. The
flat tier uses a solid fill so broad surfaces and sticky table cells render as
one continuous plane. The float tier is also solid so menus and persistent
chrome fully obscure content beneath them; subtle and overlay tiers retain
their translucency where depth or underlying content matters.
Elevation is centralized in
`frontend/src/shared/ui/LiquidGlassUI.css`, with class-name constants in
`LiquidGlassUI.ts`. Do not write a new `shadow-[...]` recipe for a general glass
surface.

Use the lowest tier that communicates the required depth:

| Material | Class | Use for |
| --- | --- | --- |
| Flat | `liquid-glass-flat` | Solid-fill assistant response/message surfaces, tables, glass cards, and signup/login/onboarding cards. |
| Subtle | `liquid-glass-subtle` | Modal inputs, dropdown triggers, tab pills, PageHeader actions, and search/select controls. |
| Float | `liquid-glass-float` | Solid-fill open dropdowns/submenus, `AppSidebar`, and persistent app/assistant/document/tabular side panels. Uses the original AppSidebar shadow depth. |
| Modal | `liquid-glass-modal` | The modal frame only; modal contents use the appropriate general tier. |
| Translucent | `liquid-glass-translucent` | Chat composer, ask-input surfaces, slash menus, and other translucent content overlays. |
| Translucent action modifier | `liquid-glass-translucent-action` | Compact over-message actions such as scroll-to-bottom; use with `liquid-glass-translucent`. |

Interactive color is separate from elevation so every tier can share one
state treatment:

| State | Class constant | Rendered class | Use for |
| --- | --- | --- | --- |
| General hover | `LIQUID_GLASS_HOVER_CLASS` | `liquid-glass-hover` | Liquid-glass controls and rows outside a modal. |
| General selected | `LIQUID_GLASS_SELECTED_CLASS` | `liquid-glass-selected` | Selected liquid-glass controls and rows outside a modal. |
| General pressed | `LIQUID_GLASS_PRESSED_CLASS` | `liquid-glass-pressed` | Momentary press feedback where needed. |
| Modal row hover | `LIQUID_GLASS_MODAL_ROW_HOVER_CLASS` | `liquid-glass-modal-row-hover` | FileDirectory, Quick Actions, workflow picker, and other rows on a modal frame. |
| Modal row selected | `LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS` | `liquid-glass-modal-row-selected` | Selected rows on a modal frame. |

The modal row pair is intentionally distinct because `liquid-glass-modal` has
a darker resting fill. Do not use it for inputs or buttons merely because they
happen to appear inside a modal; it is for selectable list rows on the modal
frame.

Every material owns its base light- and dark-theme fill, border, and elevation.
Interactive state classes may override the base fill for selected, hovered, or
focused states. The translucent material additionally owns its blur and hover
treatment because chat messages visibly pass underneath it.

Compose the material classes through the established primitives and constants:

- `GlassCardUI` — cards
- `LIQUID_FLOAT_PANEL_SURFACE_CLASS`,
  `LIQUID_SUBTLE_PANEL_SURFACE_CLASS`, and `LIQUID_TABLE_SURFACE_CLASS` in
  `components/ui/liquid-surface.ts` — panels and tables
- `DropdownContent` / `DropdownSurface` — menus
- `GlassIconButtonUI` — circular icon buttons

### Dropdowns

Every menu a button or a right-click opens is built from
`frontend/src/shared/ui/dropdown.tsx`. Web code imports it from
`@/shared/ui/dropdown`; the Word add-in uses the `@mike/dropdown-ui` alias.
There is no separate web wrapper. Do not hand-build a menu from a positioned
`div` and buttons: that loses keyboard navigation, menu roles, focus return,
and viewport collision handling.

- `Dropdown`, `DropdownTrigger`, `DropdownContent`, `DropdownItem` (with
  `selected` and `variant="destructive"`), `DropdownRadioGroup`,
  `DropdownRadioItem`, `DropdownCheckboxItem`, `DropdownLabel`,
  `DropdownSeparator` — a menu opened from a button.
- `DropdownAtPoint` — a right-click menu opened at the cursor.
- `RowActions` / `RowActionMenuItems` (`components/shared`) — a table row's
  `···` menu and the same actions as a right-click menu.
- `SelectionActionsMenu` (`components/shared`) — the toolbar "Actions" menu a
  table shows while rows are selected.
- `DropdownSurface` / `DropdownButton` — the menu's look for popovers that are
  not menus, such as a combobox's option list where focus must stay in the
  text field.

Menus stack at `z-[250]`, above modals and side panels, so call sites do not
set a z-index. Pass a `z-*` class to `DropdownContent` only when a menu must
sit under or over something specific.

Rows sit 4px apart (`DROPDOWN_ROWS_CLASS`, `flex flex-col gap-1`), applied by
`DropdownContent` and `DropdownRadioGroup`. Do not add `space-y-*` to a menu;
give any element that wraps rows inside one (a scrolling list, a group)
`DROPDOWN_ROWS_CLASS` instead. Every focus ring inside a menu is inset, and the
surface enforces that for controls that bring their own offset ring.

### Scrollbars

Scroll areas get a thin scrollbar with a transparent track from a global base
rule in `globals.css`, so a classic scrollbar (mouse connected, Windows, Linux)
does not draw an opaque gutter over a glass surface. Do not restyle scrollbars
per component; an `overflow-auto` container needs no extra class. The
spreadsheet (`.fortune-container`) and DOCX editor (`.docx-editor`) are
excluded because they size and style their own scrollbars.

For modal body scroll areas, add `data-modal-scroll="vertical"` to the scrolling
element. `ModalUI` supplies matching 8px horizontal negative margins and padding
to leave room for shadows and focus rings while keeping content aligned. Use
`data-modal-scroll="horizontal"` for scrolling tab strips; these also get 8px
vertical margins and padding. Keep this spacing in the shared modal rather than
adding margin/padding workarounds in its children. Nested menus and inset panels
keep their own spacing and should not receive this attribute.

## UI primitives

| Primitive | Location | Use it for |
| --- | --- | --- |
| `PillButtonUI` | `shared/ui` | Primary action button (`tone`: black/white/blue/danger). |
| `TextButtonUI` | `shared/ui` | Background-free actions, with optional icons and loading state. Use `textButtonUIClassName` from `TextButtonUI.styles` for links. No background, border, or shadow; hover changes text color. |
| `TabPillButtonUI` | `shared/ui` | Segmented filter/tab pills. Pass `active` to get `aria-pressed`. Resting text matches PageHeader actions (`text-gray-500`), with `text-gray-900` on hover or selection. |
| `GlassIconButtonUI` | `shared/ui` | Circular glass icon button — modal close, panel dismiss. Requires `aria-label`. |
| `CloseButton` | `shared/ui` | The small white ✕ that dismisses a modal, side panel, confirmation, toast, or `WarningPopup`. `size`: `sm` for side panels, confirmations, and notices; `md` for modals. |
| `GlassCardUI` | `shared/ui` | Canonical liquid-glass card surface. |
| `TextSlabUI` | `shared/ui` | Inset slab holding quoted or proposed text inside a card — citation quotes, tracked-change diffs, and their loading/empty states. Owns shape, padding, and fill; the caller owns typography. |
| `ToggleSwitchUI` | `shared/ui` | `role="switch"` toggle with an optional text label. |
| `CitationPillUI` | `shared/ui` | Canonical numbered citation control for web, tabular review, and Word. Uses neutral gray by default, red for verification errors, and blue for the selected state. |
| `InputUI` | `shared/ui` | Canonical shadcn input for the web app and Word add-in. |
| `form-field` | `components/ui` | `FormTextInput` (glass/minimal variants) and `FieldLabel` for app forms. |
| `NoticeCardUI` | `shared/ui` | The one card every notice is drawn with: glass surface, tone icon (error/success/info), title, message, action row, close button. Do not use it directly in a screen; use one of the two wrappers below. |
| `WarningPopup` | `components/popups` | The `NoticeCardUI` for every warning. A component opens and closes it with `open` / `onClose`; `AppToasts` renders one per `notifyError`. |
| `search-bar` | `components/ui` | Search input with clear button. Pass `label` for a meaningful accessible name. |
| `dropdown` | `shared/ui` | The one dropdown for the web app and the Word add-in: Radix menu behaviour with the liquid-glass look. See "Dropdowns" below. |
| `liquid-surface` | `components/ui` | Web-only shared surface class constants. |
| `empty-state` | `components/ui` | Icon + display heading + copy + optional action, for "nothing here yet". Wrap in `TableEmptyState` inside a table. |
| `check-square` | `components/ui` | The selection square used by directory/picker rows. Decorative by default; the row owns the ARIA state. |

For a real standalone checkbox use `<input type="checkbox">` with
`TABLE_CHECKBOX_CLASS` (see `TablePrimitive.tsx`), not `check-square`.

## Reporting failures

Every failure that stops something the user asked for must be shown to them,
with a concise and accurate message and honest next steps. "Notices: toast or
WarningPopup" below says what the notice looks like; this section says what
goes in it and when.

1. **Classify once.** `describeError` from `frontend/src/app/lib/userFacingError.ts`
   (the shared classifier in `frontend/src/shared/lib/userError.ts` plus the
   web app's fixed sentences for server-reported codes such as
   `schema_out_of_date`) turns any thrown value into
   `{ kind, title, message, retryable, supportable, requestId }`. Pass
   `action` in the imperative ("save the document") so the title reads
   "Couldn't save the document". 4xx `detail` from the backend is written for
   users and is shown; 5xx bodies and stack text never are.
2. **Show it in the right place.**
   - A form field the user is editing: inline text next to the field, using
     the description's `message`.
   - Anything else (saves, deletes, loads, exports, background refreshes):
     `notifyError(error, { action, onRetry, dedupeKey })`. `AppToasts` draws
     it as a `WarningPopup` with "Retry" (only when the failure is retryable
     and a closure is given) and "Contact support" (only for a failure the
     user cannot fix: a pre-filled email to `SUPPORT_EMAIL` carrying the
     request id, code, page and time). A component may call it for a failure
     on its own screen when it needs those actions; render a `WarningPopup`
     directly only for a warning with its own content or action.
   - A batch that failed for some items (a bulk delete, a multi-file move or
     upload): `notifyPartialFailure(message, { action, onRetry })`, one notice
     naming what did not happen, with a Retry that re-runs only those items.
   - A whole screen that cannot render: `EmptyState tone="error"` (wrapped
     in `TableEmptyState` inside a table) with a "Try again" action. An empty table must never stand in
     for "this did not load".
   - A route that threw: `app/error.tsx` and `app/global-error.tsx` offer
     "Try again" and "Contact support" with the error digest, never the
     message.
3. **Revert optimistic state** before notifying, so the screen never shows a
   change that did not happen, and revert only the item that failed. Use a
   functional updater (and `restoreOptimisticallyDeletedRows` in
   `app/lib/optimisticRows.ts` for a removed row) rather than restoring a
   snapshot of the whole list.
4. **Retry re-runs the current code.** By the time "Retry" is pressed the
   handler that failed has usually been re-created. Read it through a ref
   kept current with `useLatestRef` / `useAssignLatest`
   (`app/hooks/useLatestRef.ts`), and re-send only what did not land.
5. **Destructive actions are retried through their own entry point.** Retry
   after a failed single delete that asked for confirmation re-opens that
   confirmation; it never deletes from the notice. A delete that never asked
   (a row action on a single-version document, a review or a project) re-runs
   the same entry point. A bulk delete's Retry re-runs only the items that
   failed, which the user has already confirmed.
6. **Cancellation is not an error.** `notifyError` returns `null` for an
   `AbortError` and shows nothing.
7. **Repeats collapse.** Polling and autosave loops pass a `dedupeKey` so a
   failing loop shows one notice, not one per tick.
8. **Silence needs a reason.** A catch that intentionally shows nothing
   (cleanup, a local-storage JSON fallback, a body drain) carries a one-line
   comment saying why.

Never call `window.alert`.

## Choosing: existing primitive, shadcn registry, or a one-off

Work down this list and stop at the first that fits.

1. **A primitive in `components/ui/` (or `shared/ui/`) already does it.** Use
   it. If it is 90% right, add a prop or a variant to the primitive rather than
   forking it — a fork is how the duplication this document consolidates got
   there in the first place.
2. **A shadcn registry component does it.** Add it with the shadcn CLI so it
   lands in `components/ui/` with the project's `new-york` style and CSS
   variables, then adapt it in place. Prefer this over hand-rolling anything
   with non-trivial interaction or ARIA (menus, dialogs, popovers, tooltips).
3. **The markup is genuinely feature-specific and appears once.** Write it in
   the feature directory. One occurrence is not a primitive.
4. **The same markup now appears in two or more feature files.** Promote it:
   move it into `components/ui/` with a small prop surface, replace every copy,
   and add a test. Put it in `shared/ui/` instead only if the Word add-in needs
   it too.

Do not add a new UI dependency to solve something Tailwind plus an existing
primitive covers.

## Accessibility baseline

These are the rules the primitives already follow. Match them in new work.

- **Focus is always visible.** Every interactive primitive carries
  `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40
  focus-visible:ring-offset-2`. If you write `outline-none` you owe the element a
  replacement indicator in the same class string.
- **Focus rings are blue, never grey.** Use `ring-blue-500/40`, not `ring-ring`
  or a gray. A control that sets nothing gets the same blue from the base-layer
  `:focus-visible` rule in `ThemeTokensUI.css` (`--focus-ring-color`).
- **An inset ring traces the hover fill.** A control carrying a hover or
  selected fill class (`LIQUID_GLASS_HOVER_CLASS`, `LIQUID_GLASS_SELECTED_CLASS`,
  and the modal-row pair) gets an inset ring on that fill's perimeter by
  default. When the fill belongs to a row that wraps the focusable control, as
  in the sidebar's chat and project rows, give the control `data-focus-fill`
  and `outline-none` so the row draws the ring instead.
- **Text fields may hide the ring after a click.** Browsers match
  `:focus-visible` on a focused text field even when it was clicked. Add
  `keyboard-focus-ring` (defined in `globals.css`, driven by
  `useInputModality`) to keep the ring for Tab navigation only; the caret still
  shows focus after a click.
- **A background tint is not a focus indicator** when the tint is a small
  luminance step. Dropdown items pair the semantic focus tint with a ring for
  this reason.
- **Icon-only controls need a name.** `GlassIconButtonUI` requires `aria-label` in
  its type. When a control has a *visible* label, do not override it with a
  different `aria-label` (WCAG 2.5.3). Name an icon-only control, and let a
  control with visible text be named by that text.
- **`type="button"` on every non-submit button.** Anything inside a `<form>`
  defaults to submitting.
- **State goes in ARIA, not only in color.** `ToggleSwitchUI` uses
  `role="switch"` + `aria-checked`, `TabPillButtonUI` uses `aria-pressed`,
  `check-square` callers that own the interaction pass
  `role="checkbox"` + `aria-checked` (`"mixed"` for indeterminate).
- **Non-text contrast ≥ 3:1** for control boundaries (WCAG 1.4.11). The
  off-state switch track needs `bg-gray-300 ring-1 ring-inset ring-gray-500` to
  clear it against white; `bg-gray-100` does not.
- **Decorative elements are hidden.** Icons inside a labelled control get
  `aria-hidden`.

## Notices: toast or WarningPopup

Both show the same card, `NoticeCardUI`, so they always look alike. A
change to how a notice looks goes in `NoticeCardUI.tsx`, never in one of the
wrappers; `WarningPopup.test.tsx` fails if a popup and an error toast stop
rendering the same card. The card's dismiss control is the shared
`CloseButton`.

The title, message and supplementary content share one text column beside
the icon. Callers should not add their own left padding to supplementary
content.

Both appear in one column at the top centre of the page. `ToastViewportUI`
owns that column, and a `WarningPopup` renders into it, so a popup and a
toast stack instead of covering each other.

| | Toast (`notifySuccess`, `notifyInfo`, `showToast`) | `WarningPopup` |
| --- | --- | --- |
| Used for | Success and information | Every warning and error |
| Who opens it | Any code, including code with no React component | The component on screen through its own `open` state, or any code through `notifyError` |
| Closes | On a timer (paused on hover or focus) | Only when the user closes it or presses Escape |
| Tones | success, info | error |
| Word add-in | Yes | No (web only) |

In the web app a warning is always a **`WarningPopup`**. A component that
reports a failure on its own screen with custom content or its own action (a
rejected upload, a permission refusal) renders one directly. Everything else,
including a component failure that needs Retry or Contact support and any
code with no component of its own (the API client, a stream callback, the
offline listener), calls `notifyError`; `AppToasts` draws what it raises with
`WarningPopup`, including those actions. See "Reporting failures" above.

No two actions on one notice share a look. The last action in the row is the
primary one and is a black pill (`WarningPopup`'s `primaryAction` always
is); the one before it is a white pill; any further action is plain text.
Contact support comes first in the row, so it is black only when it is the
sole action. Style a custom action with
`noticeActionClassName(noticeActionEmphasis(index, count))`.

Use a **toast** only for a short confirmation ("Changes saved") or
information.

The Word add-in has no `WarningPopup`, so there `ToastViewportUI` draws
errors as toasts in the same top column.

## Component catalog

Every primitive in the table above has stories in the Ladle catalog. Run it
from `frontend/`:

```bash
npm run catalog          # dev server on http://localhost:61000
npm run catalog:build    # static build; this is what CI smoke-tests
```

Stories live in a `stories/` directory beside each primitive collection:
`components/ui/stories/` for web primitives and `shared/ui/stories/` for
cross-target primitives. When you add a primitive, add a story to the matching
directory in the same change. Stories are inside the app's `tsconfig`, so
`npm run build`
type-checks them: a story that drifts from its primitive's props fails CI
rather than rotting quietly. `npm run catalog:build` then bundles them, which
catches a story importing an export that no longer exists.

Two things about the catalog environment are worth knowing before you edit it:

- The catalog imports the app's real `globals.css`, so it renders on the same
  tokens and materials as the app. The theme toggle drives the same `.dark`
  class the Settings > Appearance preference sets, so dark values are real.
- Tailwind v4's automatic source detection skips dot-directories, so nothing
  in `frontend/.ladle/` is scanned for class names. Catalog chrome is styled
  with plain CSS in `.ladle/ladle.css` for that reason. Both `stories/`
  directories live under `src/` and are scanned normally, so use Tailwind
  freely in a `*.stories.tsx`.

## Related

- Frontend test conventions: [frontend-testing.md](frontend-testing.md)
