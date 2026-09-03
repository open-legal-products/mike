# Repository Instructions

## Scope

These instructions apply to the entire repository. Keep changes focused,
preserve unrelated work in the tree, and follow the more detailed guidance in
`CONTRIBUTING.md` and `docs/` when working in a documented subsystem.

The repository requires Node.js 22 or newer and contains three applications:

- `frontend/`: Next.js web application.
- `backend/`: Express API, document processing, database access, and LLM
  integration.
- `word-addin/`: Microsoft Word task-pane add-in.

The root `e2e/` directory contains the web application's Playwright tests.

## UI and Design

Read `docs/design-system.md` before making a non-trivial UI change. It is the
source of truth for tokens, spacing, surfaces, primitives, and accessibility.

Informational labels and statuses should normally be plain text rather than
decorative pill badges unless a pill is specifically requested. This does not
apply to established interactive pill controls such as `PillButton`,
`TabPillButton`, and `OptionPill`.

Before creating UI markup, search these locations in order:

1. `frontend/src/app/components/ui/` contains reusable web primitives such as
   buttons, inputs, dropdowns, search, empty states, and liquid-glass surfaces.
2. `frontend/src/shared/ui/` contains framework-light components rendered by
   both the web app and Word add-in. Files use the `XxxUI.tsx` convention, with
   thin web adapters or re-exports in `frontend/src/app/components/ui/` where
   appropriate. Code here must not import from `frontend/src/app/`.
3. `frontend/src/app/components/shared/` contains web-app building blocks that
   understand the application shell, including `PageHeader`,
   `TablePrimitive`, `TableToolbar`, `FileDirectory`, and side panels.
4. `frontend/src/app/components/modals/` and
   `frontend/src/app/components/popups/` contain the established modal,
   confirmation, and warning patterns.
5. `frontend/src/app/components/<feature>/` contains feature-specific web
   components. Keep one-off feature behavior here instead of turning it into a
   primitive prematurely.

For add-in-only work, low-level controls live in `word-addin/src/shared/ui/`
and reusable task-pane compositions live in
`word-addin/src/taskpane/components/primitives/`. If a component must render in
both the web app and add-in, prefer `frontend/src/shared/ui/`. When adding a
cross-target file there, also add its `@source` entry to
`word-addin/src/taskpane/styles.css` so Tailwind discovers its classes.

The web app is configured for shadcn's `new-york` style in
`frontend/components.json`. If no existing primitive fits a non-trivial
interaction, add the shadcn component from the `frontend/` directory so it
lands in `src/app/components/ui/`. Do not add a new UI dependency when an
existing primitive or Tailwind can solve the problem.

Design changes should follow the existing liquid-glass theme, use borders
sparingly, and use Lucide icons. Prefer the tokens and shared class constants
in `frontend/src/app/globals.css` and
`frontend/src/app/components/ui/liquid-surface.ts` over raw palette values,
custom hex colors, or copied shadow strings.

When changing layout or spacing, update the corresponding loading state at the
same time. Table skeleton helpers (`SkeletonLine` and `SkeletonDot`) live in
`frontend/src/app/components/shared/TablePrimitive.tsx`; the shared full-screen
gate is `frontend/src/app/components/shared/FullScreenLoader.tsx`. Many feature
loading states are colocated with their component, so search for
`animate-pulse`, `SkeletonLine`, and `SkeletonDot` in the affected feature.

Preserve the accessibility baseline:

- Every interactive element needs a visible focus indicator.
- Icon-only buttons need an accessible name, normally `aria-label`.
- Non-submit buttons inside forms need `type="button"`.
- Selection and toggle state must be represented with the appropriate ARIA
  attribute, not color alone.
- Use a native checkbox with `TABLE_CHECKBOX_CLASS` from
  `TablePrimitive.tsx` for standalone checkbox inputs. `CheckSquare` is the
  directory/picker row selection visual and is decorative by default.

## Frontend Structure

- Route and page components live in `frontend/src/app/`.
- Shared domain types live in
  `frontend/src/app/components/shared/types.ts`.
- Calls to the Express backend belong in `frontend/src/app/lib/mikeApi.ts` so
  authentication, API error parsing, and request behavior stay consistent.
- Reusable client behavior belongs in `frontend/src/app/hooks/` or
  `frontend/src/app/lib/`, with a colocated `*.test.ts` or `*.test.tsx` file.
- Use the `@/` alias for imports rooted at `frontend/src/`.

Do not expose raw backend, database, provider, or stack errors in the UI. Map
known 4xx responses to intentional messages and use the generic fallback
helpers in `frontend/src/app/lib/userFacingError.ts` for unexpected failures.

## Backend Structure

- Read `docs/backend-architecture.md` before adding or moving backend code.
  It is the source of truth for the module layout, the layering rules, and
  the test that enforces them.
- `backend/src/app.ts` configures Express, middleware, rate limits, and mounts
  one router per module.
- HTTP handlers and their domain logic live in
  `backend/src/modules/<domain>/`. `<name>.routes.ts` is the HTTP layer: it
  parses params/query/body, calls the service, and maps typed results onto
  status codes and JSON; it never queries the database. `<name>.service.ts`
  is the module's facade (named re-exports only, exactly one per module) and,
  for small modules, the implementation. Service code takes an explicit
  `db: Db` (from `backend/src/lib/supabase.ts`) plus request-derived
  primitives, returns typed results (`ServiceResult<T>` from
  `backend/src/lib/serviceResult.ts` for new code), and never touches
  `req`/`res`. SSE streaming loops are the one deliberate exception and stay
  in the routes file.
- Large modules split the service into topic files (`<name>.<topic>.ts`)
  behind the facade. Import a module from outside (another module, a worker,
  a job, `app.ts`) only through that facade.
- `backend/src/lib/` is the shared kernel: infrastructure and cross-domain
  primitives. It must not import from `backend/src/modules/`, and neither may
  `backend/src/middleware/`. There is no `backend/src/routes/` directory; a
  new HTTP surface is a new module.
- `backend/src/__tests__/architecture.test.ts` checks these rules on every
  test run. If it fails, fix the layering rather than the test; allowlist
  entries need a comment explaining why.
- Authentication and other request middleware live in
  `backend/src/middleware/`.
- LLM provider creation is centralized in
  `backend/src/lib/llm/providers.ts`; shared AI SDK behavior lives alongside it
  in `backend/src/lib/llm/`.
- Backend unit and integration tests live under `backend/src/__tests__/` or
  beside the relevant module as `*.test.ts`.

Keep route handlers thin when logic is reusable. Preserve authorization checks
and ownership/project-sharing boundaries on every new query or mutation. Never
send internal exception messages to clients: use the helpers in
`backend/src/lib/httpError.ts`; logging must use the redaction helpers in
`backend/src/lib/safeError.ts`. Intentional validation and permission failures
should remain explicit 4xx responses.

## Database Migrations

`backend/schema.sql` is the complete fresh-install schema.
`backend/migrations/` contains incremental changes for existing deployments.

For every new migration:

1. Use the filename `YYYYMMDD_NN_<short_name>.sql`, where the date is the
   current date and `NN` is the next unused two-digit sequence for that date.
   Inspect the directory first; never create two migrations with the same date
   and sequence. Historical filenames do not all follow the current convention.
2. Add `-- Migration date: YYYY-MM-DD` at the top.
3. Make the new migration safe to re-run where possible: use `if exists` / `if
   not exists`, `create or replace` for functions, drop-before-create for
   policies and constraints, and guarded data backfills or type changes.
4. Update `backend/schema.sql` with the migration's final database shape in the
   same change.
5. Preserve RLS, grants, ownership, security-definer settings, and explicit
   `search_path` hardening when changing database objects.

Existing deployments apply only files newer than their recorded version, in
filename order. Do not assume every historical migration is safely replayable,
and do not apply migrations to a remote or production database unless the user
explicitly requests it and the target has been confirmed. See
`docs/deployment.md` for deployment procedure and `.github/workflows/schema-drift.yml`
for the fresh-versus-upgraded schema check.

## Verification

Choose the smallest verification that can catch the regression, and expand it
for cross-cutting or high-risk changes. A build is not required after every
small edit, but relevant tests are required for risky behavior changes and
when specifically requested.

Common commands from the repository root:

```bash
npm test --prefix backend
npm run build --prefix backend

npm test --prefix frontend
npm run test:coverage --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend

npm run typecheck --prefix word-addin
npm run build --prefix word-addin
npm run test:e2e --prefix word-addin

npm run test:e2e
npm run test:e2e:local
npm run test:stack --prefix backend
```

Use targeted Vitest files while iterating, for example:

```bash
npm test --prefix backend -- src/__tests__/integration/tabular.routes.test.ts
npm test --prefix frontend -- src/app/components/ui/button.test.tsx
```

The stack and browser suites require their documented local services. Consult
`docs/frontend-testing.md`, `docs/e2e-ci.md`, and `docs/safe-local-testing.md`
before running them. New behavior should normally have a regression test at
the lowest useful layer: unit first, route integration second, and Playwright
only when a real browser flow is necessary.

When changing dependencies, update the `package-lock.json` belonging to the
affected package. Before handing off work, run `git diff --check`, inspect the
diff for unrelated changes, and report which verification commands were run.

## Pull Requests

Keep a pull request focused on one feature, bug, or cleanup. Write PR
descriptions in Markdown and include:

- Summary.
- What changed.
- Why it changed.
- Testing performed.

Do not commit secrets, API keys, private documents, `.env` files, build output,
or local test artifacts.
