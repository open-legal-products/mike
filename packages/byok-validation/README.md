# Shared BYOK validation cases

`cases.json` is the shared conformance suite for the rules that decide which
user-supplied Bring Your Own Keys values Mike accepts. It is data, not code:
it has no build step and nothing imports it at runtime.

The backend is the authority for every rule. The web app keeps a browser copy
of some of them only so a settings field can explain a rejected value before
the save round trip:

| Rule | Backend (authoritative) | Browser copy |
| --- | --- | --- |
| Account-specific model ids (Bedrock, Azure, Foundry, Vertex, xAI, custom) | `isSafeAccountModelId` in `backend/src/lib/llm/models.ts` | `isSafeAccountModelId` in `frontend/src/app/lib/accountModelIds.ts` |
| OpenAI-compatible endpoint base URLs | `normalizeCustomBaseUrl` in `backend/src/lib/llm/cloudProviders.ts` | `normalizeCustomBaseUrl` in `frontend/src/app/lib/cloudProviderSettings.ts` |

The copies are duplicated rather than shared because the backend builds with
plain `tsc` and no bundler, and `tsc` does not rewrite path aliases; see
`packages/pdf-text-order/README.md` for the same constraint. This file is what
keeps them honest: the backend and frontend suites both assert against it, so
changing one copy without the other fails CI.

## Case format

`accountModelProviders` lists the six providers whose model ids are
account-specific; both copies must know the same list. `accountModelIds` cases give an id without its router prefix, whether it is
`valid`, and `why`. `providers` limits a case to some of the six
account-specific providers; without it the case applies to all six.

```json
{ "id": "meta/llama-4-maverick-maas", "valid": true, "why": "Vertex partner model" }
```

`customBaseUrls` cases give an `input`, the backend's normalized result as
`expected` (`null` for a rejected URL) and `why`. The browser copy checks only
the common private ranges, so a case may add `browser` with the result the
browser gives instead and why. That is only ever allowed one way: the browser
may accept a URL the backend rejects (the save then fails with the backend's
reason), never reject one the backend accepts. The frontend suite enforces
that direction.

```json
{ "input": "https://192.0.2.10/v1", "expected": null, "why": "IPv4 documentation range",
  "browser": { "expected": "https://192.0.2.10/v1", "why": "the browser only lists the common private ranges" } }
```

When changing a rule:

1. Update the backend rule and the browser copy together.
2. Add a case for the input that motivated the change.
3. Run `npm test --prefix backend -- src/lib/__tests__/byokValidationCases.test.ts`
   and `npm test --prefix frontend -- src/app/lib/byokValidationCases.test.ts`.
