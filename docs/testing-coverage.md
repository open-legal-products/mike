# Backend unit-test coverage

The backend has a Vitest unit-test harness over all of `backend/src/**`
(routes, modules, workers, and middleware included — the scope was widened
from `src/lib/**` in 2026-08 so untested areas can't silently drop to zero).
This doc tracks what is covered, what still needs tests, and how the coverage
ratchet works — so you can pick up a checkbox below and land it as a small PR.

## Running the tests

```bash
cd backend
npm install
npm test              # run all unit tests
npm run test:coverage # same, plus the per-file coverage table + floor check
```

Tests live throughout `backend/src/**/*.test.ts`, including `lib/__tests__/`,
nested feature directories, `routes/__tests__/`, and `src/__tests__/integration/`.
Read a couple of the existing suites first (`lib/__tests__/access.test.ts`,
`lib/__tests__/userDataCleanup.test.ts`) and match their conventions: plain
in-memory Supabase query mocks for unit tests, no real network, one `describe`
block per function or concern, and assertions on current behavior. Tests that
need a real local Supabase stack are explicitly gated.

## Current coverage (measured 2026-08)

Per-area statement coverage from `npm run test:coverage`:

| Lib area | % statements | Tested? |
| --- | ---: | :---: |
| `lib/userDataCleanup.ts`, `lib/manifestSigning.ts`, `lib/supabase.ts` | 100 | ✓ |
| `lib/llm/models.ts` | 96 | ✓ |
| `lib/chat/types.ts` | 95 | ✓ |
| `lib/documentVersions.ts` | 98 | ✓ |
| `lib/chat/citations.ts` | 98 | ✓ |
| `lib/userLookup.ts` | 91 | ✓ |
| `lib/docxTrackedChanges.ts` | 89 | ✓ |
| `lib/downloadTokens.ts` | 87 | ✓ |
| `lib/access.ts` | 76 | ✓ |
| `lib/storage.ts`, `lib/upload.ts` | 58 | partial |
| `lib/workflowCatalog.ts` | 69 | partial |
| `lib/workflowCatalogSource.ts`, `lib/workflowCatalogSync.ts` | 74–96 | ✓ |
| `lib/userDataExport.ts` | 43 | partial |
| `lib/chat/contextBuilders.ts`, `lib/chat/tools/toolDispatcher.ts` | 37–38 | partial |
| `lib/userApiKeys.ts` | 13 | partial — provider/env helpers only |
| `lib/chat/tools/documentOps.ts` | 10 | partial |
| `lib/convert.ts`, `lib/chat/streaming.ts`, `lib/courtlistener.ts` | 2–5 | minimal |
| `lib/llm/**` | 5 | minimal outside `models.ts` |
| `lib/mcp/**` | 6 | minimal |
| `lib/userSettings.ts`, `lib/officeText.ts`, `lib/spreadsheet.ts` | 0 | ✗ |

Global (measured over the widened `src/**` scope, which now includes
`routes/`, `modules/`, `workers/` and `middleware/` rather than `src/lib/**`
alone): **47.56% statements / 40.86% branches / 49.78% functions / 49.20%
lines**; the ratchet floors in `backend/vitest.config.mts` sit ~2 points below
those. The global number is held down by a few very large feature libs
(toolDispatcher, documentOps, courtlistener, MCP, provider adapters) that are
still untested and dominate the line count.

## TODO — untested libs, in priority order

Each item is meant to be one self-contained PR: add the suite, then raise the
floors in `backend/vitest.config.mts` to just below the new measured numbers.
Size is a rough guess: S ≈ an hour, M ≈ an afternoon.

- [x] `lib/documentTypes.ts` — pure catalog/lookup of document types; assert
      known types resolve and unknown inputs fall back sanely. (S)
- [x] `lib/chat/prompts.ts` — pure prompt builders; assert key instructions and
      interpolated values appear in the output strings. (S)
- [ ] `lib/userSettings.ts` — title/tabular model resolution from which API
      keys a user has; reuse the Supabase mock pattern from
      `userLookup.test.ts`. (S)
- [ ] `lib/upload.ts` — multer wrapper: assert LIMIT_FILE_SIZE maps to a 413
      with the right message and other errors pass through. (S)
- [ ] `lib/officeText.ts` — office XML text extraction; build a tiny in-memory
      zip fixture with JSZip and assert extracted/decoded text. (S)
- [ ] `lib/chat/tools/toolSchemas.ts` — assert every tool schema has a name,
      description, and well-formed parameters (guards against schema drift). (S)
- [ ] `lib/userApiKeys.ts` (rest) — encrypt/decrypt round-trip and DB
      load/store paths with a mocked Supabase client. (M)
- [ ] `lib/storage.ts` (rest) — S3 upload/download/list/delete wrappers with a
      mocked AWS SDK client. (M)
- [ ] `lib/userDataExport.ts` — export assembly: given seeded mock tables,
      assert the export contains the user's data and nobody else's. (M)
- [ ] `lib/spreadsheet.ts` — parse a small in-memory xlsx fixture; assert sheet
      and cell extraction, including empty/edge cells. (M)
- [ ] `lib/chat/contextBuilders.ts` — context assembly from doc stores; assert
      doc labels, truncation, and ordering. (M)
- [x] `lib/docxTrackedChanges.ts` — tracked-changes XML round-trip on a minimal
      docx fixture: insert/delete runs, accept/reject. High value: document
      integrity. (M)
- [ ] `lib/courtlistener.ts` — API client with mocked fetch: query building,
      pagination, and error paths. Legal-research correctness. (M)
- [x] `lib/workflowCatalogSource.ts`, `lib/workflowCatalogSync.ts` — validate
      downloaded workflow definitions, temporary-file cleanup, asset uploads,
      and the transactional import payload. (M)
- [ ] `lib/llm/aiSdk.ts` + `lib/llm/providers.ts` — provider-neutral tool plumbing
      and provider selection with mocked provider modules. (M)
- [ ] `lib/mcp/types.ts` + `lib/mcp/servers.ts` — server config validation and
      allow-listing logic; security relevant. (M)
- [ ] `lib/mcp/client.ts` + `lib/mcp/oauth.ts` — connection lifecycle and OAuth
      token handling with a mocked MCP SDK; security relevant. (M)
- [ ] `lib/llm/rawStreamLog.ts` — log path construction and redaction with a
      mocked fs. (S)
- [ ] `lib/chat/tools/documentOps.ts` — start with the pure helpers (diff/match
      utilities), not the full tool handlers. (M)
- [ ] `lib/chat/tools/toolDispatcher.ts` — dispatch table routing and argument
      validation with stubbed tools; don't try to cover every tool body. (M)
- [ ] `lib/chat/streaming.ts` + `lib/llm/{aiSdk,providers}.ts` — streaming
      loops and provider adapters; hardest to unit test, consider extracting
      pure chunk-parsing helpers first. (M)

Not worth unit testing directly: `lib/supabase.ts` and `lib/convert.ts` are
thin wrappers around external services (Supabase auth, LibreOffice); they are
better exercised by the e2e suite.

## Ratchet policy

`backend/vitest.config.mts` enforces global coverage **floors** (currently
statements 45 / branches 38 / functions 47 / lines 47). They are a
no-regression ratchet, not a target:

- **Floors only go up.** Never lower them to get a PR green — that means your
  change removed tested behavior or added a large untested lib; add tests
  instead.
- **Raise them in the same PR that adds tests.** After your suite passes, run
  `npm run test:coverage`, take the new global numbers, and set each floor to
  the measured value rounded down to a whole percent.
- Keep the measured numbers in the config comment and the table above honest
  when you do.
