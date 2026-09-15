# Test Depth: Mutation Testing and the SSE Load Harness

Two on-demand tools that go a level deeper than the regular vitest suite.
**Neither gates merges** — see "Why not merge gates?" at the bottom.

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
- `src/modules/chat/engine/citations.ts` — citation extraction (what the model may
  cite from which document)

### Running it

```bash
cd backend
npm ci
npm run test:mutation
```

Takes about 3 minutes locally. Or run the **Mutation testing** workflow
from the Actions tab (it also runs itself monthly as a drift check).

### Reading the report

Open `backend/reports/mutation/mutation.html` (in CI: download the
`mutation-report` artifact). Click a file to see every mutant inline:

- **Killed (green)** — a test caught the change. Good.
- **Survived (red)** — the suite still passed with that bug in place.
  Each one is a concrete, ready-made test case: write the assertion that
  would have failed.
- **No coverage** — no test even runs that code. Coverage gap, not an
  assertion gap.

Scores measured when this harness landed varied by file (citations ~78–80,
downloadTokens 65.4, access 63.6). The access figure is mostly
no-coverage mutants in
`listAccessibleProjectIds`/`filterAccessibleDocumentIds` — its score on
*covered* code is 82.4.
`thresholds.break` is set to **69**, ~5 points under the lowest measured
score, so a run fails only on a genuine regression.
When you kill survivors, raise `break` in the same PR — floors only go up.

### Current tooling limitation

With the backend's TypeScript 7 dependency, Stryker 10 currently aborts during
sandbox setup because it calls the removed `parseConfigFileTextToJson` API.
Its corrected mutation targets are discovered, but no mutation score is
produced. The regular unit, coverage, typecheck, database, and browser checks
remain separate; a green CI run does not imply this optional harness passed.

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

### Running from GitHub Actions

The **SSE load test** workflow (`.github/workflows/loadtest.yml`) is
manual-only and boots nothing itself: give it the base URL of an already
running non-production stack you deployed — anything serving the backend
API (`POST /chat` behind Supabase bearer auth) with real provider keys —
and store a test user's token in the `LOADTEST_AUTH_TOKEN` repository
secret. **Never point it at production.**

## Why not merge gates?

- **Cost/latency.** Mutation testing multiplies suite runtime by the
  mutant count; the load test needs a live stack with real provider keys.
  Both are too slow/stateful to sit in front of every PR for a solo
  maintainer, and a flaky required check is worse than none.
- **They detect drift, not correctness of a single diff.** The monthly
  mutation cron catches "tests went hollow" over time; the load harness
  is for before/after checks around streaming changes and incident
  reproduction.

If the project grows contributors and a permanent staging stack, the
natural next step is: mutation testing on changed security-lib files in
PRs, and a small smoke-scale k6 run post-deploy. Until then: on demand.
