# Frontend unit-test coverage

The frontend has a Vitest (jsdom) unit-test harness. This doc tracks what is
covered, what still needs tests, and how the coverage ratchet works — the
frontend counterpart of [testing-coverage.md](testing-coverage.md), which does
the same for the backend. Pick up a checkbox below and land it as a small PR.

## Running the tests

```bash
cd frontend
npm install
npm test              # run all unit tests
npm run test:coverage # same, plus the per-file coverage table + floor check
```

TypeScript is pinned to 5.9.3 so ESLint can use the compiler API supported by
the installed TypeScript ESLint parser. When upgrading it, run `npm run lint`
and `npx tsc --noEmit` together to check parser and compiler compatibility.

Fortune-sheet is pinned because the spreadsheet viewer adjusts internal DOM
scroll extents. Upgrades must pass `SpreadsheetWorkbook.zoom.test.tsx` and
`SpreadsheetView.session.test.tsx`, followed by a browser check of zoom and
scrolling to the last row and column.

Tests live next to the code they test (`*.test.ts` / `*.test.tsx`). Read a
couple of the existing suites first (`src/app/lib/mikeApi.test.ts`,
`src/app/hooks/useAssistantChat.sse.test.ts`) and match their conventions:
mock `global fetch` and the Supabase client module — no network, no real
backend — one `describe` block per function or concern, and tests that assert
current behavior.

## Assistant streaming regressions

Changes to chat rendering, effect dependencies, scrolling or reveal animations
must exercise a long conversation and paced streaming, not just a completed
response. `e2e/assistant-streaming.spec.ts` loads eight synthetic exchanges and
sends four content replies or eight reasoning replies through a browser
`ReadableStream`, with CPU throttling. The reasoning case also expands,
collapses and resizes a live disclosure. Both cases run in the general assistant,
project assistant and tabular-review chat (six browser scenarios).
It uses the real Next.js/React renderer, fails on browser console errors and
uncaught exceptions, and requires no model-provider key. It runs in the regular
production Playwright suite on every PR. The separate **Assistant streaming
(development)** job reruns it on `next dev`, because React's
passive-update-depth warning is development-only; that job runs nightly, on
manual dispatch, and on PRs labelled `stress` (see
[e2e-ci.md](e2e-ci.md#development-stress-jobs)). Add the label to PRs that touch
streaming or render loops.

Run it against the documented local stack with:

```bash
npm run test:e2e -- e2e/assistant-streaming.spec.ts
```

For a standalone frontend already running on localhost, its API fixtures and
empty storage state also allow a run without backend/auth setup:

```bash
CI=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run test:e2e -- \
  e2e/assistant-streaming.spec.ts --project=chromium --no-deps
```

For scroll state, observe the viewport and content size and respond to scroll
events. A changing `messages` array is not a layout signal: an effect that sets
scroll state on every chunk can exhaust React's passive-update limit, even when
the boolean is unchanged. Avoid dispatching equal values before calling the
setter; pending concurrent work can prevent React's eager bailout. The
`ChatView.actions.test.tsx` regressions check content reveal without a new message,
resize/scroll behavior, 120 consecutive chunks and observer/frame cleanup.

When investigating maximum-depth warnings, trace the repeated passive updates
as well as the final stack. The reveal animation can be the next setter that
crosses the limit, while a different component's effect caused the buildup.

## Review effects for update loops and starvation

Treat streamed text, message arrays, freshly allocated objects and callbacks as
high-frequency inputs. Before adding a state-setting effect, identify its actual
trigger and how it terminates:

- Derive display defaults from props during render. Keep state for user choices,
  rather than mirroring `isStreaming` on every chunk.
- Observe natural content size for overflow measurements. Coalesce observer
  callbacks into one animation frame and compare against the last published
  value **before** dispatching state. Observing a clipped wrapper can hide growth.
- Position/reveal a transcript when its chat, loading state or user-message count
  changes. Do not restart a timer or a two-frame layout operation on every text
  chunk: the callback can be starved indefinitely even without a console warning.
- Trace parent callbacks and external-store snapshots when objects change every
  render. Fix the source of instability; do not suppress exhaustive-deps or add
  arbitrary debounce delays to hide it.
- Keep an animation's elapsed time across new chunks and stop requesting frames
  when caught up. Test deltas arriving just before each frame, not only an idle
  clock after a single append.
- Reset user selections on navigation identity, not refreshed object identity.
  A row/document refetch should not close a pane or replace a chosen source.
- Retire asynchronous history requests on selection, new chat, deletion and
  unmount. Test reversed response order, including A → B → A: checking only the
  chat ID misses stale requests for the same chat.
- Test cleanup on close, unmount and Strict Mode remount. Test that work settles
  while geometry is unchanged, and that resize without a new message still works.

A functional setter returning its existing value is not sufficient evidence that
an effect is bounded under concurrent rendering. `useReasoningDisclosure.test.tsx`
checks 300 text updates, repeated resize notifications and cleanup. The assistant
and tabular chat suites interleave chunks with frame/timer advancement and assert
that history becomes visible **before** the stream ends. A buffered SSE fixture
or assertions only after `[DONE]` would miss those failures.

The Word add-in uses the same disclosure hook. Its
`word-addin/e2e/assistant-streaming.spec.ts` sends sixteen exchanges through paced
SSE in Chromium and WebKit, including a live resize to 320px and disclosure
interactions. Keep both production and development jobs required in branch
protection. Run the development check with no existing server on port 3100:

```bash
WORD_E2E_DEVELOPMENT=1 REACT_STRESS=1 npm run test:e2e --prefix word-addin -- \
  --retries=0
```

An existing local server is reused by Playwright, so make sure it serves the
intended build mode. Development bundles are static-served with the same Office
mock; the test does not need Word, HTTPS certificates or a real backend.

The complete web suite also runs on both production and development builds in
CI. `REACT_STRESS=1` applies 4x Chromium CPU throttling and fails UI fixtures on
maximum-depth, excessive-render, uncached-snapshot and ResizeObserver-loop
diagnostics. Word runs its complete hermetic suite in both build modes and both
engines; WebKit has no equivalent CDP CPU-throttling control. Existing error-path
tests may intentionally log other errors; the focused streaming/history tests
additionally fail on every console error and uncaught exception.
Stress mode disables retries and retains failed traces, so an intermittent loop
cannot become a passing check merely because a retry uses different timing.

`e2e/tabular-chat-lifecycle.spec.ts` switches sixteen times while history requests
are held, then releases long transcripts in reverse order. The latest selection
must remain visible before and after a narrow viewport resize.

See [the class audit](incidents/2026-09-29-streaming-effects-audit.md) for the
confirmed failures, unaffected paths examined and limits of the investigation.

## What the coverage gate covers

The ratchet gates `src/app/lib/**` only — the client library — mirroring the
backend's decision to gate `src/lib/**`. Components and hooks have their own
suites (they run in the same `npm test`), but their coverage is UI-shaped and
noisy, so they are exercised without being floor-gated.

## Current coverage (measured 2026-08)

Per-file statement coverage of the gated lib layer from
`npm run test:coverage`:

| Lib file | % statements | Tested? |
| --- | ---: | :---: |
| `lib/documentUploadValidation.ts` | 100 | ✓ |
| `lib/deleteTabularReviewsWithConcurrency.ts` | 100 | ✓ |
| `lib/folderDeleteState.ts` | 100 | ✓ |
| `lib/modelAvailability.ts` | 100 | ✓ |
| `lib/paginatedRows.ts` | 100 | ✓ |
| `lib/utils.ts` | 100 | ✓ |
| `lib/supabase.ts` | 100 | ✓ |
| `lib/mikeApi.ts` | 99.77 | ✓ — every endpoint wrapper asserted |

Global (lib layer): **99.81% statements / 97.09% branches / 100% functions /
100% lines**. The only uncovered code is the dev-only logging branch and a
couple of `?? null` default arms. `mikeApi.ts` now has a route/method/body
assertion for every thin endpoint wrapper (folders, library, workflows, MCP
connectors, document versions) on top of the earlier plumbing, mapping, and
streaming suites.

Outside the gate, the SSE **parse** loop — the frontend half of the SSE
contract with the backend (`data: <json>\n\n` lines) — is covered in
`src/app/hooks/useAssistantChat.sse.test.ts`: chunk-boundary reassembly,
multi-event chunks, reasoning/content interleaving, `error` events, malformed
lines, and end-of-stream flush without a trailing newline.

## TODO — untested surfaces, in priority order

Each item is one self-contained PR: add the suite, then (for lib files) raise
the floors in `frontend/vitest.config.mts` to just below the new measured
numbers. Size guess: S ≈ an hour, M ≈ an afternoon.

- [ ] Assistant message rendering — start with the pure helpers
      `components/assistant/message/citationUtils.ts` and `eventUtils.ts`,
      then render `EventBlocks` / `MarkdownContent` with fixture events and
      assert what a lawyer actually sees (citations, edit cards, error
      blocks). Highest-value component surface. (M)
- [ ] Tabular review state — `components/tabular/TabularReviewView.tsx` and
      `TRChatPanel.tsx` each contain their own copy of the SSE read loop plus
      cell/flag state transitions; test the state transitions with mocked
      streams the way `useAssistantChat.sse.test.ts` does. Consider extracting
      the duplicated parse loop into a shared lib helper first, which would
      also pull it under the coverage gate. (M) The server-owned half of both
      is already covered: `TabularReviewView.generation.test.tsx` and the
      "server-owned turns" block in `TRChatPanel.test.tsx` (Stop through the
      endpoint, reconnect with `from`, attach on open).
- [x] `lib/mikeApi.ts` (rest) — the remaining thin wrappers: folders/library
      moves, workflows share/hide, MCP connectors, document versions. Done as
      a table-driven `it.each` suite of URL/method/body assertions. (M)
- [ ] `hooks/useSelectedModel.ts` — model choice persistence and fallback to
      `DEFAULT_MODEL_ID` when the stored model is unavailable. (S)
- [ ] `hooks/useGenerateChatTitle.ts` — title generation trigger and failure
      tolerance (a failed title must never break the chat). (S)
- [ ] `hooks/useFetchSingleDoc.ts` + `useFetchDocxBytes.ts` — fetch/refresh
      lifecycle with mocked `mikeApi`. (S)
- [ ] `useAssistantChat` beyond parsing — `ask_inputs` handling and the
      tool-event placeholder lifecycle. (M) Stop, detach, return-to-thread
      and resume after a reload are covered by
      `useAssistantChat.lifecycle.test.tsx`, `assistantTurns.test.ts` and
      `assistantTurnStream.test.ts`.

Not worth unit testing directly: `lib/supabase.ts` is a thin wrapper around
`createClient` (better exercised by the e2e suite), and `app/` page components
are mostly composition.

## Ratchet policy

`frontend/vitest.config.mts` enforces global coverage **floors** over
`src/app/lib/**` (currently statements 99 / branches 97 / functions 100 /
lines 100). Same rules as the backend
([testing-coverage.md](testing-coverage.md#ratchet-policy)):

- **Floors only go up.** Never lower them to get a PR green — that means your
  change removed tested behavior or added a large untested lib; add tests
  instead.
- **Raise them in the same PR that adds tests.** After your suite passes, run
  `npm run test:coverage`, take the new global numbers, and set each floor to
  the measured value rounded down to a whole percent.
- Keep the measured numbers in the config comment and the table above honest
  when you do.
