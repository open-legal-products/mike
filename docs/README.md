# Documentation

## Run and deploy Mike

- [Local development](local-development.md) — Docker Compose, local services,
  registration, Ollama, and first-run setup
- [Manual and production deployment](deployment.md) — managed infrastructure,
  environment variables, database upgrades, and deployment safety
- [Troubleshooting](troubleshooting.md) — common local and production problems
- [Safe local testing](safe-local-testing.md) — disposable resources, synthetic
  documents, and secret handling

## Features and clients

- [CourtListener integration](courtlistener.md) — live US case-law tools and
  optional bulk data
- [Microsoft Word add-in](../word-addin/README.md) — concise setup and command
  reference
- [Word add-in development and deployment](word-addin-development.md) — manual
  setup, sideloading, builds, storage behavior, testing, and troubleshooting
- [Tamper-evident exports](tamper-evident-exports.md) — document hashes and
  optional signed manifests

## Backend

- [Backend architecture](backend-architecture.md) — domain modules over a
  shared kernel: module anatomy, the service contract, the layering rules, and
  the fitness test that enforces them

## Frontend

- [Design system](design-system.md) — color/typography/spacing tokens, the shared
  `components/ui` primitives, and the accessibility baseline

## Testing and CI

- [End-to-end tests in CI](e2e-ci.md)
- [Backend unit-test coverage](testing-coverage.md)
- [Frontend unit-test coverage](frontend-testing.md)
- [Mutation testing and the SSE load harness](test-depth.md)

## Historical design and investigation notes

These files preserve the context of completed work. They are not current setup
or architecture guidance.

- [Legal workflows design spec](superpowers/specs/2026-06-29-legal-workflows-design.md)
- [Word add-in assistant scroll-jump report](word-addin-chat-scroll-report.md)

Contribution and disclosure policies live in [CONTRIBUTING.md](../CONTRIBUTING.md)
and [SECURITY.md](../SECURITY.md).
