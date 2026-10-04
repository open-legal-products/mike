# End-to-end tests in CI

The Playwright suite (`e2e/`) runs on every pull request through
`.github/workflows/e2e.yml`. This document covers its local test services and the **branch-protection step that turns a red run into a blocked
merge** — the workflow reports pass/fail on its own, but only branch protection
makes that check *required*.

## What the workflow does

On every `pull_request`, including stacked PRs targeting another feature branch,
on manual `workflow_dispatch`, and **nightly at 03:47 UTC** (a `schedule` cron,
so drift that lands between PRs — dependency bumps, Supabase CLI changes,
selector-breaking UI tweaks — is caught within a day), the `e2e / playwright`
matrix:

1. installs the root (Playwright), `backend/`, and `frontend/` dependencies;
2. boots **RustFS** (S3-compatible object storage — several specs upload documents);
3. boots **local Supabase** (Auth + Postgres) via the Supabase CLI and loads the
   current fresh-install shape from `backend/schema.sql`. It intentionally does
   not replay historical migrations on top: doing so can replace current
   functions with older definitions. The separate schema-drift workflow proves
   that the supported upgrade path (its pinned baseline plus later migrations)
   converges with this fresh-install path;
4. writes `backend/.env` and `frontend/.env.local` from the live Supabase values;
5. builds the backend and runs the pinned `sync:workflows` release job, matching
   production ordering so the default and add-on catalog exists before startup;
6. serves the production build (`next build` / `next start`) in one job and
   the development renderer (`next dev`) in another. The development job warms
   static routes, sets `REACT_STRESS=1` for 4x Chromium CPU pressure, and fails
   on React/observer loop diagnostics. Development overlays remain observable;
   they are not suppressed to make selectors pass. Both jobs use the backend
   API (`:3001`) and web server (`:3000`) with isolated disposable services;
7. runs `npx playwright test --project=chromium` on three parallel workers and
   uploads the HTML report + traces as an artifact (`playwright-report-production` /
   `playwright-report-development`) on pass, fail, or timeout.

### Test users and parallel workers

Each Playwright worker signs in as its **own** user, following Playwright's
[one account per parallel worker](https://playwright.dev/docs/auth#moderate-one-account-per-parallel-worker)
pattern. Worker 0 is the historical `e2e@mike.local` (or `E2E_EMAIL` /
`E2E_PASSWORD`); worker *n* is `e2e-wn@mike.local` with the same password
(`workerAccount()` in `e2e/users.ts`). The worker-scoped fixture in
`e2e/fixtures.ts` creates the account through the local Supabase admin API,
signs in once, finishes onboarding and reuses the session for every test in
that worker. Separate users have separate project, chat and workflow lists and
separate sessions, so workers can't race on each other's data. Tests inside a
file still run in order. `e2e/auth.setup.ts` only creates the dedicated logout
user, whose global sign-out must never revoke a shared session. No login secret
is needed.

`E2E_WORKERS` sets the worker count (CI sets 3; the default is 1, because
`next dev` compiles routes on demand). A spec that needs a specific user's
details takes the `e2eAccount` fixture instead of hardcoding an email.

### Synthetic specs

`e2e/assistant-streaming.spec.ts` and `e2e/tabular-chat-lifecycle.spec.ts` form
the Playwright **`synthetic`** project. They mock every `/api` call in the
browser and need no backend, database, account or model-provider key, so CI
runs them in a separate job that serves only the web app. The streaming tests
are slow by design (4x CPU throttling and hundreds of SSE chunks, up to two
minutes each), and four of them on one 4-vCPU runner slowed each other about
2.5x, so the job is a matrix of three runners split by chat scope: `assistant`,
`project` and `rest` (every other synthetic test, so a new one is never
dropped), each on two workers. On every PR they report as **Assistant streaming
(production, assistant | project | rest)**; the `development` renderer against
`next dev` is a stress job. Keeping them out of the full-stack job is what
keeps that job short. See [frontend-testing.md](frontend-testing.md#assistant-streaming-regressions)
for a standalone local command.

CI runs every browser flow using a local Anthropic-protocol fixture. No paid
model key or repository secret is required, including on fork PRs. A missing
fixture key fails test discovery instead of silently skipping chat coverage.

### Development stress jobs

Three jobs run against React's development renderer, which is 3-4x slower than
the production build: **`e2e / Playwright (development stress)`** (~25-35 min),
**`e2e / Assistant streaming (development, …)`** (~20-27 min before the split) and **`Word add-in /
Development stress (chromium + webkit)`** (~18-24 min). They were the last checks
to finish on every slow PR, so they are off the default PR path. They run:

- nightly (e2e at 03:47 UTC, the Word add-in at 04:17 UTC) and on manual
  dispatch;
- on every push to `main` (Word add-in only);
- on any PR carrying the **`stress`** label.

Add `stress` to PRs that touch streaming, render loops or effect dependencies.
The label is read when a run starts, so push a commit (or close and reopen the
PR) after adding it. There is deliberately no `labeled` trigger: a run started
by an unrelated label would report every check as skipped, and GitHub treats a
skipped required check as passing, which would hide an earlier red run.

Because these checks are absent on unlabelled PRs, do **not** mark them as
required status checks: a required check that never reports blocks the merge.

## Accessibility scans

`e2e/accessibility.spec.ts` runs an [axe-core](https://github.com/dequelabs/axe-core)
scan (via `@axe-core/playwright`) over the core pages: `/login` (pre-auth),
`/assistant`, `/projects`, and `/tabular-reviews`. The policy is two-tier:
**`critical`-impact violations fail the build**; `serious`-impact violations are
printed to the test output but do not fail — enforce at critical first, then
ratchet `serious` into the failing tier (`BLOCKING_IMPACTS` in the spec) once
that backlog is cleared. The scans need no LLM key and run on every trigger.

## Failure artifacts

The production suite retries failed specs up to twice on CI and records a
**trace** on the first retry. Development stress uses **zero retries** and
retains traces on failure, so an intermittent loop cannot pass on a retry.
On pass, fail, or timeout, each full-stack job uploads `playwright-report/`,
`test-results/` and the web-server log as **`playwright-report-production`** or
**`playwright-report-development`** (14-day retention). The focused development
job uploads **`assistant-streaming-development`** with the same failure evidence.
From the failed run's page in the Actions tab, download its artifact, then
`npx playwright show-report playwright-report` locally to see per-spec results,
screenshots, and step-by-step traces of what the browser did.

## Deterministic model provider

The workflow starts `e2e/anthropic-stub.mjs` on loopback port 4141 and sets
`ANTHROPIC_BASE_URL=http://127.0.0.1:4141/v1` plus a dummy API key. The installed
Anthropic SDK supports this endpoint override. Browser requests still traverse
the real web gateway, authentication, backend, database, document storage, and
assistant streaming code; only the external model response is a fixture.

The fixture supports streamed answers and non-streaming title generation. Its
protocol checks use the backend's installed SDK before the workflow starts the
server. This verifies application flows, not live model quality or availability.

The shared `selectClaudeModel` helper selects a supported Anthropic model before
each chat submission. Keep its model label synchronized with the model catalog.
Check the **Run Playwright** summary and uploaded report for passing tests with
no unexpected skips; do not rely on a green job that omitted chat coverage.

For a local run with the same fixture, start `node e2e/anthropic-stub.mjs` and
export both variables above (use `ANTHROPIC_API_KEY=e2e-local-key`) before starting
the backend and Playwright. Local runs can instead use a live Anthropic key with
no endpoint override. Local runs without either configuration skip the chat
flows; CI rejects that incomplete configuration.

## Make it merge-blocking

The workflow failing is not enough on its own — GitHub will still allow the merge
unless the check is **required**. Enable branch protection once you have seen the
suite go green a few times (it is environment-sensitive by nature):

1. **Settings → Branches → Add branch protection rule** (or edit the rule for
   `main`).
2. Enable **Require status checks to pass before merging**.
3. Enable **Require branches to be up to date before merging**.
4. In the checks search box add **`e2e / playwright`**,
   the three **`e2e / Assistant streaming (production, assistant|project|rest)`** checks and
   **`Word add-in / Typecheck and Playwright (chromium + webkit)`**. Jobs appear
   in the list after they have run at least once on a PR. Do not require the
   development-stress checks; they only run on PRs labelled `stress` (see
   [Development stress jobs](#development-stress-jobs)).
5. Keep the existing unit/build, security and `license/cla` requirements.
6. Save. From now on a red e2e run blocks the **Merge** button.

This PR adds workflow checks; it does not edit repository protection settings.
When configuring them through an API, first read and preserve the existing
requirements and use the exact check contexts reported by the repository.

## Running the suite locally

Locally, `playwright.config.ts` starts the backend and web dev servers for you
(`webServer` is only disabled when `CI=true`), so a full local stack plus:

```bash
npm ci
npx playwright install --with-deps chromium
npm run test:e2e            # or test:e2e:ui / test:e2e:headed
```

`e2e/auth.setup.ts` reads `SUPABASE_URL` / `SUPABASE_SECRET_KEY` from the
environment or `backend/.env`, so a running local Supabase + a populated
`backend/.env` is all the setup needs.
