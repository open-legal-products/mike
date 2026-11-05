# Contributing

Thanks for helping improve Mike. Please keep contributions small, focused, and easy to review.

## Guidelines

- For changes that touch multiple subsystems, the data model, or public API/behavior, open a PRD issue first using the "New PRD" template (`docs/templates/PRD.md`); for small, well-understood fixes, a plain issue is fine.
- Prefer targeted edits over broad refactors.
- Keep each PR focused on one bug, feature, or cleanup.
- Update docs or env examples when changing setup, config, or user-facing behavior.
- Keep self-hosting changes compatible with the supported Docker Compose,
  Supabase, S3-compatible storage, and Ollama paths. Explain any new local
  infrastructure or migration requirements in the same PR.
- Do not commit secrets, API keys, private documents, or local `.env` files.

## Frontend UI Work

Before writing a new component, check whether one already exists. Look first in
`frontend/src/app/components/ui/` (and `packages/ui/`, imported as `@mike/ui`,
for anything the Word add-in also renders), then in the
[shadcn/ui](https://ui.shadcn.com)
registry — the project is configured for it in `frontend/components.json`, so
`npx shadcn@latest add <component>` lands a component in the right place with
the right style and tokens. Write a one-off in the feature directory only when
the markup is genuinely specific to that feature; once the same markup shows up
in a second feature file, promote it into `components/ui/` with a test and
replace the copies. Use the documented color, typography, spacing and radius
tokens rather than raw hex values, and keep the accessibility baseline (visible
focus ring, accessible name on icon-only controls, `type="button"`, ARIA state
alongside color). See [docs/design-system.md](docs/design-system.md) for the
tokens, the primitive inventory, and the full baseline.

## Before Opening a PR

- Run the relevant build or test command for the area you changed.
- Check `git diff` and remove unrelated changes.
- Write a concise Markdown PR description with:
    - summary
    - changes
    - why
    - testing

## Mike Workflows

System workflows live in the sibling
[`Open-Legal-Products/mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository under `assistant-workflows/` and `tabular-review-workflows/`. Put
structured metadata in the YAML frontmatter at the top of `SKILL.md`, put
workflow instructions in the body of `SKILL.md`, and use `table-columns.yaml`
for tabular review columns.

How workflows reach users:

- **Defaults.** Five workflows are marked as defaults by the ingestion policy
  in `backend/src/lib/workflowCatalogSource.ts`. The workflow sync job stores
  that classification and the Quick Action settings in
  `mike_workflows`; Postgres installs independent, editable copies for each
  user on first use.
- **Add-ons.** Every other workflow in the repository ships in the Add-ons
  catalog. Users import an add-on as an independent, editable copy of the
  workflow.
- **Packs.** A directory with a `pack.yaml` groups its child workflow
  directories into a pack shown together in the catalog. `pack.yaml` must list
  exactly the workflow directories that exist under it — the build fails on
  either a listed-but-missing or an unlisted workflow.
- The `metadata.mike-availability` frontmatter key is deprecated and ignored:
  the default/add-on split comes from `DEFAULT_WORKFLOWS`, not from the
  workflow files. Existing files may keep the key; the ingestion parser
  accepts it but does not use it for classification.

Deployments run the dedicated workflow ingestion job after applying database
migrations and before starting the backend:

```bash
cd backend
npm run build
npm run sync:workflows
```

The job resolves the configured `mike-workflows` ref to an immutable commit,
downloads and validates its archive, writes a temporary local JSON document,
uploads reference assets to object storage, and transactionally replaces the
active rows in `mike_workflows`. Its temporary files are deleted before the job
exits. The backend only reads the database and does not download or generate a
catalog during startup. Docker Compose runs the job automatically; managed
deployments should run `npm run sync:workflows` as a release step.

`scripts/build-workflows.js` remains only for the optional landing-site build;
it does not produce backend runtime data.

## Security

Do not open a public issue for security vulnerabilities. Use [GitHub's private vulnerability reporting](https://github.com/Open-Legal-Products/mike/security/advisories/new) instead.

We will aim to respond promptly and coordinate a disclosure timeline with you.

## Local Development

Backend:

```bash
npm run build --prefix backend
```

Frontend:

```bash
npm run build --prefix frontend
```

## Testing

```bash
npm test --prefix backend            # backend unit + route integration tests (vitest)
npm test --prefix frontend           # frontend component/hook tests (vitest + jsdom)
npm run test:e2e                     # Playwright end-to-end suite — see docs/e2e-ci.md
npm run test:stack --prefix backend  # gated: real-Supabase auth/access tests (run `supabase start` first)
```

- New features and bug fixes should come with a test at the lowest layer that
  can catch the regression: unit first, then route-level integration, then
  end-to-end only for flows a browser is genuinely needed to prove.
- CI runs the build and unit/integration tests on every PR
  (`.github/workflows/ci.yml`), and the Playwright suite in a full local stack
  (`.github/workflows/e2e.yml`). The CI workflow will also run the optional
  offline eval harness if `evals/run.mjs` is added to the tree.
- Tests that need a live Supabase or an LLM key are env-gated and skip cleanly
  when the environment is absent — a plain `npm test` should always be green.
