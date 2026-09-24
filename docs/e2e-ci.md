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
job:

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
6. **builds** the web app (`next build`) and serves it with `next start` — a
   production build, not `next dev`, so there is no on-demand compilation (which
   makes first-hit page loads slow enough to time out specs) and no dev
   hydration-error overlay (whose injected DOM pollutes text locators). Starts the
   backend API (`:3001`) and the web server (`:3000`) and waits for both healthy;
7. runs `npx playwright test` and uploads the HTML report + traces as an artifact
   (`playwright-report`) on pass, fail, or timeout.

`e2e/auth.setup.ts` bootstraps the shared test user (`e2e@mike.local`) against
the local Supabase admin API, so no login secret is needed — the credentials
baked into that file are the single source of truth.

CI runs every browser flow using a local Anthropic-protocol fixture. No paid
model key or repository secret is required, including on fork PRs. A missing
fixture key fails test discovery instead of silently skipping chat coverage.

## Accessibility scans

`e2e/accessibility.spec.ts` runs an [axe-core](https://github.com/dequelabs/axe-core)
scan (via `@axe-core/playwright`) over the core pages: `/login` (pre-auth),
`/assistant`, `/projects`, and `/tabular-reviews`. The policy is two-tier:
**`critical`-impact violations fail the build**; `serious`-impact violations are
printed to the test output but do not fail — enforce at critical first, then
ratchet `serious` into the failing tier (`BLOCKING_IMPACTS` in the spec) once
that backlog is cleared. The scans need no LLM key and run on every trigger.

## Failure artifacts

Playwright retries failed specs up to twice on CI and records a **trace** on the
first retry (`retries` / `trace: "on-first-retry"` in `playwright.config.ts`).
On pass, fail, or timeout, the job uploads `playwright-report/` and
`test-results/` as the **`playwright-report`** artifact (14-day retention): from
the failed run's page in the Actions tab, download it, then
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
4. In the checks search box add **`e2e / playwright`** (the job appears in the
   list after it has run at least once on a PR).
5. Recommended alongside it: the unit/build check `backend` and the `license/cla`
   check.
6. Save. From now on a red e2e run blocks the **Merge** button.

Equivalent via the GitHub CLI (repo admin token required):

```bash
gh api -X PUT repos/OWNER/REPO/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=e2e / playwright' \
  -f 'enforce_admins=true' \
  -f 'required_pull_request_reviews[required_approving_review_count]=1' \
  -f 'restrictions='
```

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
