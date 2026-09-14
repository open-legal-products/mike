# Test Depth: Mutation Testing and the SSE Load Harness

Two tools that go a level deeper than the regular vitest suite. Neither
gates merges today: the mutation harness is blocked on upstream tool
support (see below), and the load harness is local/on-demand — see "What
gates merges?" at the bottom.

## Mutation testing (backend security libs)

Line coverage tells you a test *executed* a line; it says nothing about
whether any test would fail if that line's behavior changed. Mutation
testing closes that gap: [Stryker](https://stryker-mutator.io/) makes
hundreds of small, deliberate bugs ("mutants" — flip a `===` to `!==`,
delete an early `return`, weaken a regex) and re-runs the suite for each
one. A mutant the suite fails on is "killed"; a mutant the suite passes on
"survived" — a real behavior change no test noticed.

We run it only on the security-critical libs, where a hollow test is
dangerous (scope in `backend/stryker.config.json`):

- `src/lib/access.ts` — project/document sharing access checks
- `src/lib/downloadTokens.ts` — HMAC-signed download tokens
- `src/lib/chat/citations.ts` — citation extraction (what the model may
  cite from which document)
- `src/lib/chat/verifyCitations.ts` — quote-against-source verification
  (the "verified" badge)
- `src/lib/privateIp.ts` — the SSRF private/reserved-IP guard for
  server-side connector fetches

### Running it

```bash
cd backend
npm ci
npm run test:mutation
```

Takes about a minute locally (~2 in CI). The **Mutation testing**
workflow can be dispatched from the Actions tab and runs itself monthly
as a drift check. It is **not** a PR gate — see "Blocked on vitest 5"
below for why the promotion to one was held back.

### Blocked on vitest 5 (since 2026-09-11)

`npm run test:mutation` cannot currently produce a real score.
`@stryker-mutator/vitest-runner` 10.0.0 — the latest release — does not
work with vitest 5, which the repo moved to in #455 on 2026-09-11. Two
separate breakages, both reproduced locally on 2026-09-14:

1. **Hard crash.** Stryker's sandbox rewrites `tsconfig.json` with
   `ts.parseConfigFileTextToJson`, an API TypeScript 7 removed, so the run
   dies with `TypeError: ts.parseConfigFileTextToJson is not a function`
   before mutating anything. `stryker.config.json` works around this by
   pointing `tsconfigFile` at a name that does not exist — safe here
   because `backend/tsconfig.json` has no `extends` and no `references`,
   so the rewrite it skips is a no-op for this project.
2. **Silent zero, no workaround.** Past the crash, the initial dry run
   succeeds and per-test mutant coverage is collected, but the per-mutant
   runs read back no test results at all (`Ran 0.00 tests per mutant on
   average`). Every mutant is therefore scored "survived" and the total
   is **0.00** — a red run that reads as "the tests collapsed" when
   nothing about the tests changed. `coverageAnalysis: "all"`,
   `vitest.related: false` and forced static mutant activation were all
   tried; none of them changes the result.

So the harness fails loudly rather than lying green — but its failure
message is misleading, and a 0.00 PR gate would block every
security-lib PR for a reason that has nothing to do with the PR. That is
why `mutation.yml` kept its dispatch + cron triggers instead of gaining
the `pull_request:` trigger it was about to get.

**Revival:** when `@stryker-mutator/*` ships vitest 5 support, bump it,
run `npm run test:mutation`, confirm a real score, raise
`thresholds.break` to the new measured floor, and add back the
`pull_request:` trigger with a `paths:` filter matching the `mutate`
array in `backend/stryker.config.json`. The last honest measurement is
below.

### Reading the report

Open `backend/reports/mutation/mutation.html` (in CI: download the
`mutation-report` artifact). Click a file to see every mutant inline:

- **Killed (green)** — a test caught the change. Good.
- **Survived (red)** — the suite still passed with that bug in place.
  Each one is a concrete, ready-made test case: write the assertion that
  would have failed.
- **No coverage** — no test even runs that code. Coverage gap, not an
  assertion gap.

Scores last measured 2026-08-27 with all five files in scope, on vitest 4
(green cron run 2026-09-03; see "Blocked on vitest 5" above for why there
is no newer number): total 70.0
(citations 79.2, verifyCitations 63.5, downloadTokens 65.4, access 63.8,
privateIp 65.9). The access figure is mostly no-coverage mutants in
`listAccessibleProjectIds`/`filterAccessibleDocumentIds` — its score on
*covered* code is 82.2. `ignoreStatic` is on: module-load-time mutants
(the BlockList subnet tables) can't be toggled by mutation switching and
would survive spuriously; their runtime behavior is asserted directly in
`privateIp.test.ts`. `thresholds.break` is **69**, just under the
measured total, so a run fails only on a genuine regression.
When you kill survivors, raise `break` in the same PR — floors only go up.

## SSE load harness (k6)

The streaming chat endpoint (`POST /chat`) is the product's hot path and
the source of past incidents (streams timing out on long tool calls).
`loadtest/sse-stream.js` is a [k6](https://k6.io/) scenario that ramps up
to N concurrent streaming requests and checks, per stream:

- the response is `200` + `text/event-stream`,
- the stream actually starts (the `chat_id` event arrives),
- the stream runs to completion (the `data: [DONE]` sentinel arrives),
- time-to-first-byte and full-stream duration, as metrics.

Thresholds are deliberately lenient (documented inline in the script):
TTFB p95 < 15 s, ≥ 90% of streams complete, < 20% in-stream error events.
A red run means "streams hang or the stack is falling over", not "we
missed an SLO we never agreed on".

### Running locally against the local stack

1. Start the backend as usual (see `docs/safe-local-testing.md` — a
   disposable Supabase project and low-limit provider keys; the test
   creates real chats and burns real tokens on whatever it hits).
2. Raise the chat rate limit for the run, or the harness trips it from a
   single IP immediately: `RATE_LIMIT_CHAT_MAX=100000` in `backend/.env`
   (default is 30 per 15 min per IP).
3. Get an access token for a test user, e.g. with the Supabase JS client:

   ```js
   const { data } = await supabase.auth.signInWithPassword({
     email: "test@example.com",
     password: "...",
   });
   console.log(data.session.access_token);
   ```

4. Run k6 (native binary, or the docker image if you don't have k6):

   ```bash
   BASE_URL=http://localhost:3001 AUTH_TOKEN=eyJ... VUS=5 \
     k6 run loadtest/sse-stream.js

   # or via docker (host networking so localhost resolves):
   docker run --rm -i --network host \
     -e BASE_URL=http://localhost:3001 -e AUTH_TOKEN=eyJ... -e VUS=5 \
     -v "$PWD:/work" -w /work grafana/k6:latest run loadtest/sse-stream.js
   ```

Tune with `VUS`, `RAMP_DURATION`, `HOLD_DURATION`, `PROMPT`.

There is deliberately no GitHub Actions workflow for the load harness.
One existed (`.github/workflows/loadtest.yml`, 2026-08-12 to 2026-08-27)
but was removed without ever having run: it required an externally
deployed non-production stack and a `LOADTEST_AUTH_TOKEN` repository
secret, neither of which ever existed, so it sat in the Actions tab as a
gate that could not execute. The k6 scenario above is the actual tool;
if the project ever gains a permanent staging stack, a smoke-scale
post-deploy run of it is the natural workflow to (re)add — resurrect the
removed workflow from git history as a starting point.

## What gates merges?

- **Mutation testing does not gate anything today.** It is blocked on
  vitest 5 support in `@stryker-mutator/vitest-runner` (above). The
  monthly cron still runs, so the block stays visible in the Actions tab
  instead of being forgotten. When the block lifts, the intended shape is
  a path-filtered PR gate on the mutated security libs, their tests and
  the harness itself: a measured run costs ~2 minutes, so gating those
  PRs is cheap and unrelated PRs never pay it.
- **The load harness never gates.** It needs a live stack and real
  provider keys, and it detects capacity/stability drift, not the
  correctness of a single diff — it is for before/after checks around
  streaming changes and incident reproduction.
