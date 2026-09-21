# PRD: USPTO Patent & Trademark connector

Date: 2026-09-20. Status: implemented for review. This PRD follows
`docs/templates/PRD.md`. It records the problem, the scope, and the accepted
approach.

## Problem

Legal users who run Mike need patent and trademark research inside the
assistant. Mike supports remote MCP servers over Streamable HTTP only. The
USPTO MCP server (`riemannzeta/patent_mcp_server`) runs as a local stdio
process, so no existing transport can use it. Users of the reference fork
have this capability today and need it in MikeOSS.

## Non-goals / out of scope

- Scheduled trademark watches and the Monitors subsystem.
- General local-command connectors. Only the fixed USPTO identity runs a
  local process.
- A fork or patch of `riemannzeta/patent_mcp_server`. The upstream package
  stays unmodified.
- Per-user USPTO credentials as the only model. The deployment environment
  variables stay the shared default. A user can save encrypted overrides in
  Settings > Connectors, and a saved value takes precedence.
- PDF download tools. They return container-local paths and stay available
  only where the paths are usable; no browser download adapter exists yet.

## Proposed solution

Add a managed stdio connector for the pinned upstream server, behind a
per-user feature switch.

- A switch under Settings > Features named USPTO Patent & Trademark. The
  column `user_profiles.uspto_connector_enabled` defaults to false. The
  backend enforces the switch at provisioning, tool refresh, model tool
  exposure, and tool execution. Off never starts a child process.
- A one-click setup under Settings > Connectors through
  `POST /user/mcp-connectors/presets/patent`. A partial unique index gives
  one managed connector per user, and repeat setup is idempotent. Managed
  connectors keep tool choices, allow rename and enable/disable, and block
  endpoint edits, OAuth, and deletion.
- A managed adapter under `backend/src/lib/mcp/` with a fixed command,
  an environment allowlist, bounded process lifetime, and a concurrency
  limit. Commands come only from trusted server configuration.
- The fork's exact-owner trademark search, ported to typed TypeScript.
  It calls the upstream server's published MCP tools and preserves
  pagination, pacing, rate-limit retries, partial results, and JSON caps.
- Docker and native builds. The backend image preinstalls pinned uv,
  Python 3.13, and the pinned server package. Native installs use a pinned
  `uvx` command.

## Alternatives considered

- Hosted HTTP deployment of the upstream server. It avoids the stdio schema
  change, but it needs deployment, authentication, endpoint, and network
  validation. It also loses the fork's one-click setup and owner adapter.
- Feature flag through an environment variable only. Rejected. The user
  must control the feature, and the switch must persist per user.

## Technical approach / affected areas

- `backend/src/lib/mcp/`: new `patentServer.ts` and
  `trademarkOwnerSearch.ts`; transport selection, gates, and provisioning
  in `servers.ts`.
- `backend/src/modules/user/`: profile column plumbing, the presets route,
  and service wrappers.
- `backend/schema.sql` and
  `backend/migrations/20260920_01_uspto_patent_trademark_connector.sql`:
  the profile column, the narrowed stdio transport check, and the
  per-user unique index.
- `packages/contracts/`: the serialized connector transport declaration.
- Frontend: Settings > Features switch, the Connectors setup action, and
  managed connector details.
- `backend/Dockerfile`, `docker-compose.yml`, `backend/.env.example`.
- Docs: `docs/patent-mcp-connector.md` and `docs/tmsearch-waf-token.md`.

## Success metrics

- Default off for new and existing users, with backend enforcement at
  every entry point.
- A fresh Docker Compose checkout starts the pinned server with no host
  Python or uv.
- Existing HTTP and OAuth connector behavior and tests stay unchanged.
- The exact-owner search matches the fork's semantics in unit tests.

## Open questions

- Tool availability: upstream marks some tools unavailable after USPTO API
  shutdowns. Mike reports upstream outages as upstream failures, not
  connector failures.
- Per-user USPTO credentials are implemented as an override: a user can save
  the three values in Settings > Connectors, encrypted at rest. The deployment
  environment variables remain the shared default.
- PDF download tools need a download adapter before they help browser
  users.
