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
catalog entry without adding behavior. `GlassCardUI`, `PillButtonUI`,
`GlassIconButtonUI`, `TabPillButtonUI`, and `ToggleSwitchUI` are the canonical
implementations used by both targets. To style a link as a pill, apply
`pillButtonUIClassName` from `PillButtonUI.styles` directly to the link; this
keeps the correct link semantics and is safe in server components.

## Color tokens

Two families coexist. Prefer a token over a raw Tailwind palette class whenever
one exists; prefer either over a hex literal.

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
utilities.

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
`text-2xl font-serif` (display headings and empty states). There is no separate
heading component; use `EmptyState` for empty-state headings and `PageHeader`
for page titles so the display style stays in one place.

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
- `LiquidDropdownContent` / `LiquidDropdownSurface` — menus
- `GlassIconButtonUI` — circular icon buttons

## UI primitives

| Primitive | Location | Use it for |
| --- | --- | --- |
| `PillButtonUI` | `shared/ui` | Primary action button (`tone`: black/white/blue/danger). |
| `TabPillButtonUI` | `shared/ui` | Segmented filter/tab pills. Pass `active` to get `aria-pressed`. |
| `GlassIconButtonUI` | `shared/ui` | Circular glass icon button — modal close, panel dismiss. Requires `aria-label`. |
| `GlassCardUI` | `shared/ui` | Canonical liquid-glass card surface. |
| `TextSlabUI` | `shared/ui` | Inset slab holding quoted or proposed text inside a card — citation quotes, tracked-change diffs, and their loading/empty states. Owns shape, padding, and fill; the caller owns typography. |
| `ToggleSwitchUI` | `shared/ui` | `role="switch"` toggle with an optional text label. |
| `CitationPillUI` | `shared/ui` | Canonical numbered citation control for web, tabular review, and Word. Uses neutral gray by default, red for verification errors, and blue for the selected state. |
| `input`, `form-field` | `components/ui` | shadcn input; `FormTextInput` (glass/minimal variants) and `FieldLabel` for app forms. |
| `search-bar` | `components/ui` | Search input with clear button. Pass `label` for a meaningful accessible name. |
| `dropdown-menu` | `components/ui` | Radix/shadcn menu primitives. |
| `liquid-dropdown` | `components/ui` | The glass skin over `dropdown-menu` — use this in app chrome. |
| `liquid-surface` | `components/ui` | Web-only shared surface class constants. |
| `empty-state` | `components/ui` | Icon + display heading + copy + optional action, for "nothing here yet". Wrap in `TableEmptyState` inside a table. |
| `check-square` | `components/ui` | The selection square used by directory/picker rows. Decorative by default; the row owns the ARIA state. |
| `ToastUI` | `shared/ui` | Global toast (snackbar) stack. Raise with `showToast`; in the web app prefer `notifyError`/`notifySuccess` from `app/lib/userFacingError.ts`. See "Reporting failures" below. |
| `TableErrorState` | `components/shared` | "This didn't load" inside a table: icon, heading, the described message and a "Try again" button. |

For a real standalone checkbox use `<input type="checkbox">` with
`TABLE_CHECKBOX_CLASS` (see `TablePrimitive.tsx`), not `check-square`.

## Reporting failures

Every failure that stops something the user asked for must be shown to them,
with a concise and accurate message and honest next steps. The layers, from
the inside out:

1. **Classify once.** `describeError` in `frontend/src/shared/lib/userError.ts`
   turns any thrown value (a `MikeApiError`, a fetch `TypeError`, an
   `AbortError`, an Office.js error, a plain string) into
   `{ kind, title, message, retryable, supportable, requestId }`. Pass
   `action` in the imperative ("save the document") so the title reads
   "Couldn't save the document". 4xx `detail` from the backend is written for
   users and is shown; 5xx bodies and stack text never are.
2. **Show it in the right place.**
   - A form field the user is editing: inline text next to the field, using
     the description's `message`. Add "Contact support" (a link built with
     `supportMailtoFor`) when `supportable`, and "Retry" when `retryable`.
   - Anything else (saves, deletes, loads, exports, background refreshes):
     `notifyError(error, { action, onRetry, dedupeKey })` from
     `frontend/src/app/lib/userFacingError.ts`. It raises a `ToastUI` error
     toast with "Retry" (only when the failure is retryable and a closure is
     given) and "Contact support" (only when the failure is one the user
     cannot fix), which opens a pre-filled email to `SUPPORT_EMAIL`
     (`will@mikeoss.com`) carrying the request id, code, page and time.
   - A whole screen that cannot render: `EmptyState tone="error"`, or
     `TableErrorState` from `components/shared/TablePrimitive.tsx` inside a
     table, with a "Try again" action.
   - A route that threw: `app/error.tsx` and `app/global-error.tsx` offer
     "Try again" and "Contact support" with the error digest.
   The Word add-in mounts the same `ToastViewportUI` and uses
   `word-addin/src/taskpane/lib/notify.ts`, so both clients read the same
   sentences.
3. **Revert optimistic state** before notifying, so the screen never shows a
   change that did not happen — but revert only the item that failed. Use a
   functional updater (and `restoreOptimisticallyDeletedRows` in
   `app/lib/optimisticRows.ts` for a removed row) rather than restoring a
   snapshot of the whole list, and let `onRetry` re-read the current state
   through a ref: by the time it runs, the request that failed is no longer
   the last thing that happened.
4. **Cancellation is not an error.** `notifyError` returns `null` for an
   `AbortError` and shows nothing.
5. **Repeats collapse.** Polling and autosave loops pass a `dedupeKey` so a
   failing loop shows one toast, not one per tick.
6. **The toast stack protects what must be acted on.** Only three toasts
   are visible at once; when the stack overflows it drops dismissible
   notices (info, success, errors with nothing to click) oldest-first and
   keeps an error that offers "Retry" or "Contact support". Toasts never
   take focus — that would pull the caret out of what the user is typing —
   but `focusToast(id)` moves it deliberately for a failure that must be
   dealt with now.
7. **Silence needs a reason.** A catch that intentionally shows nothing
   (cleanup, a local-storage JSON fallback, a body drain) carries a one-line
   comment saying why.

`WarningPopup` remains for contextual warnings that carry their own action or
custom content; plain failure strings go through `notifyError`. Never call
`window.alert`.

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
- **A background tint is not a focus indicator** when the tint is a small
  luminance step. `liquid-dropdown` items pair the semantic focus tint with a
  ring for this reason.
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
