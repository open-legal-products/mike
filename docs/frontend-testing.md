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
      also pull it under the coverage gate. (M)
- [x] `lib/mikeApi.ts` (rest) — the remaining thin wrappers: folders/library
      moves, workflows share/hide, MCP connectors, document versions. Done as
      a table-driven `it.each` suite of URL/method/body assertions. (M)
- [ ] `hooks/useSelectedModel.ts` — model choice persistence and fallback to
      `DEFAULT_MODEL_ID` when the stored model is unavailable. (S)
- [ ] `hooks/useGenerateChatTitle.ts` — title generation trigger and failure
      tolerance (a failed title must never break the chat). (S)
- [ ] `hooks/useFetchSingleDoc.ts` + `useFetchDocxBytes.ts` — fetch/refresh
      lifecycle with mocked `mikeApi`. (S)
- [ ] `useAssistantChat` beyond parsing — cancellation (`AbortError` →
      "Cancelled by user."), `ask_inputs` handling, and the tool-event
      placeholder lifecycle. (M)

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
