# @mike/client

Client behavior shared by the Mike web app (`frontend/`) and the Word add-in
(`word-addin/`) that has nothing to do with rendering:

- `userError.ts`, `toastStore.ts`, `errorNotifier.ts`: one classification of a
  thrown value and one toast store, so a failure reads the same in Word as on
  the web. `CODE_KINDS` is the table of server `code`s a client acts on.
- `modelCatalog.ts`: the model catalog both pickers are built from, kept in
  line with `backend/src/lib/llm/models.ts` by
  `frontend/src/wordAddin/catalogParity.test.ts`.
- `uploadSessionClient.ts` (with `settleWithConcurrency.ts`, `secureUuid.ts`):
  the upload-session protocol.
- `messageExcerpts.ts`: the wire format for quoting a passage of a response.
- `sentryEvent.ts`, `sentryPrivacy.ts`: Sentry event hygiene. `sentryPrivacy.ts`
  is byte-identical to `backend/src/lib/observability/sentryPrivacy.ts`; the
  sync test guards it.

## Public surface

`src/index.ts` is the package's only entry point:

```ts
import { describeError, MODELS, serializeExcerpts } from "@mike/client";
```

A file under `src/` that `index.ts` does not re-export is internal.

## Rules

- Framework-free. No React (type-only imports excepted), no DOM access at
  module scope, nothing from `frontend/src/app/` or `word-addin/src/`. The
  add-in's Playwright suite loads this package directly in Node.
- `@mike/ui` may depend on this package; this package never depends on
  `@mike/ui`.

## How it is wired

This is a source package with no build step and no `node_modules`. Each
application maps the name to `src/index.ts` with a tsconfig `paths` entry (and,
for the add-in, a webpack alias). Both Dockerfiles copy this directory to
`/packages/client`, the path the aliases resolve to in the image;
`frontend/src/__tests__/architecture.test.ts` checks that the alias and the
copy agree.

## Tests

Tests are colocated (`src/*.test.ts`) and run with the frontend's Vitest:

```bash
npm test --prefix frontend -- ../packages/client
```
