# Plan: fully self-contained Mike.app

**Goal.** A user downloads `Mike.app` and everything runs locally on their Mac —
no Docker, no separate server, no cloud dependency (except LLM API calls, which
are supplied per-user via Settings → API Keys, env vars, or a local Ollama).
This complements the hosted default (`https://app.mikeoss.com`): hosted stays
the zero-friction path; "Run locally on this Mac" becomes a third mode next to
hosted and self-hosted-URL on the connect screen.

**Design principle preserved.** Shell-over-rewrite stands: the web app and the
backend run byte-identical to the docker-compose stack. What changes is only
*who starts the processes* — a supervisor inside the Electron shell instead of
compose. The web app receives no privileged APIs and is never forked.

---

## 1. What the compose stack actually runs (research inventory)

| Service | Role | Self-contained implication |
|---|---|---|
| `db` (supabase/postgres 17) | Postgres. Extensions actually used: **only `pgcrypto` + `pg_trgm`** (`backend/schema.sql:6-7`). No pgvector on main. Schema has FKs + a trigger on `auth.users`. | A vanilla Postgres 17 with contrib suffices. |
| `auth` (gotrue v2.189.0) | Browser-facing auth: signup/signin/refresh, updateUser, **full TOTP MFA** (enroll/challenge/verify/AAL). Backend uses admin endpoints (getUserById, deleteUser). Runs its own migrations to build `auth.*`. | Reimplementing this surface is large and security-sensitive → bundle the real binary. |
| `rest` (PostgREST v14) | The backend's **only** DB access path — 436 `.from()` call sites + 12 SQL RPCs via the service-role supabase-js client (`backend/src/lib/supabase.ts`). The backend never opens a raw Postgres connection. | Rewriting the seam is weeks of churn → bundle the real binary. |
| `gateway` (nginx) | ~50 lines: `/auth/v1/* → gotrue`, `/rest/v1/* → postgrest`, CORS. | Trivially replaced by a small Node proxy in the shell. |
| `db-init` | Applies `backend/schema.sql` idempotently after `auth.users` exists. Compose never applies `backend/migrations/` — fresh installs rely on schema.sql/migrations convergence (schema-drift CI gate). | Desktop needs a real migration runner for upgrades. |
| `mailpit` | SMTP catcher. Signup is autoconfirmed (`GOTRUE_MAILER_AUTOCONFIRM: true`); mail only matters for password recovery / email change. | Skip in v1; note the product decision. |
| `storage` (rustfs, S3 API) | Accessed **only by the backend** (`backend/src/lib/storage.ts`, aws-sdk). Browser uploads are multipart to the backend; presigned GET URLs escape to the browser from exactly two call sites (`routes/documents.ts:268`, `routes/workflows.ts:1072`); everything else uses the HMAC `/download/:token` route. | Replace with a local-filesystem storage adapter; no S3 daemon needed. |
| `backend` (Express) | Boots with no side effects. **No Redis/BullMQ/workers on main** (durable queues = unmerged PR #294, off by default). Conversion runs in-process: `libreoffice-convert` shells out to `soffice` (`lib/convert.ts`); text extraction is pure JS (`pdfjs-dist`, `mammoth`, `xlsx`). | Run as a child process. LibreOffice is the only heavyweight external tool, and the product already degrades gracefully without it. |
| `frontend` (Next.js 15) | All product logic is client-side; no `src/app/api`, no server actions, no realtime. Needs a Node server only for dynamic `[id]` routes. Three `NEXT_PUBLIC_*` vars are baked at build time. | `next build` with `output: "standalone"`, run its `server.js`. Static export won't work (no SPA fallback for dynamic routes). |

**Key architectural fact:** the frontend touches Supabase **only for auth** —
its sole Supabase client (`frontend/src/app/lib/supabase.ts`) is used 100% for
`supabase.auth.*` / `supabase.auth.mfa.*`. All data flows browser → backend →
PostgREST. So the app must serve, on loopback: Next server, Express backend, a
GoTrue-compatible auth API, a PostgREST-compatible data API, a real TCP
Postgres, storage, and (optionally) `soffice`.

**Why not PGlite:** GoTrue and PostgREST need a wire-protocol TCP Postgres;
PGlite is in-process/single-connection. Real Postgres binaries it is.

**Licensing:** GoTrue (MIT), PostgREST (MIT, official macOS aarch64 releases),
Postgres (PostgreSQL License) — all permissive, all arm64-macOS-buildable.
LibreOffice is MPL-2.0 but ~700MB–1GB, hence "detect, don't bundle" below.

## 2. Recommended option per component

| Component | Recommendation | Rejected alternative | Risk |
|---|---|---|---|
| Postgres | Bundle Postgres 17 arm64 binaries (e.g. `@embedded-postgres/darwin-arm64` zonky builds) in `Contents/Resources/pg/`; first run `initdb` into userData, create Supabase roles, start on loopback. Verify contrib ships (pgcrypto/pg_trgm). | PGlite (no TCP server); requiring Postgres.app | Low-med (~40MB) |
| PostgREST | Bundle the official macOS aarch64 binary, pinned to v14.x. | Rewriting 436 call sites | Low (~15MB) |
| GoTrue | Build `supabase/auth` v2.189.0 from source for darwin/arm64 (`CGO_ENABLED=0 go build`) and bundle — the only component without official mac binaries. | Local auth shim (would reimplement sessions, refresh, TOTP MFA, admin endpoints) | Med (~25MB, one-time build pipeline) |
| Gateway | ~60-line Node reverse proxy in the shell/supervisor mirroring `supabase/gateway.conf`; it also **injects the per-install `apikey` JWT** (solves the baked-anon-key problem below). | Bundling nginx | Low |
| Backend | Compiled backend (`tsc` → dist) as a child process via Electron's own binary with `ELECTRON_RUN_AS_NODE=1`; prod-pruned `node_modules` as extraResources. | Running in the main process (couples crash domains) | Low |
| Frontend | `output: "standalone"` behind an env flag in `frontend/next.config.ts` (upstreamable); run `server.js` the same way; bake `NEXT_PUBLIC_*` to fixed loopback URLs at desktop build time. | Static export; `file://` loading | Low |
| Storage | Land the `StorageAdapter` seam (upstream PR #47 lineage: `adapter.ts` + `setStorageAdapter()`), add an `fs.ts` adapter under userData. `getSignedUrl` (2 callers) returns a backend-served URL via the existing HMAC token machinery; extend `routes/downloads.ts` to cover workflow-reference keys (today it only resolves `document_versions.storage_path`). | Bundling RustFS/MinIO (another daemon + presign/endpoint gymnastics — cf. commit `556c8d6`) | Med |
| Redis/queues | Nothing to do on main; keep #294's flag off in the desktop profile if it merges. | — | None |
| Mail | Don't bundle mailpit; GoTrue autoconfirm on. Password recovery unavailable locally in v1 (product decision; a small SMTP sink is a later option). | — | Low |
| LibreOffice | **Detect, don't bundle**: supervisor sets `SOFFICE_BINARY_PATH=/Applications/LibreOffice.app/.../soffice` when installed. Absent → `has_pdf_rendition: false` and the UI falls back to client-side `docx-preview` (existing graceful path). v2: optional on-demand signed download. | Bundling (+700MB) | Low |
| LLM | Existing: per-user encrypted keys, env keys, **Ollama** (`lib/llm/ollama.ts`) for fully local. Revive keyless **demo mode #260** (stacked on provider-registry #259) for the first-run answer. | — | Low |

**Secrets:** generated per-install on first run into userData (ideally via
Electron `safeStorage`): JWT secret, anon + service_role JWTs (HS256, minted
with node `crypto`), `DOWNLOAD_SIGNING_SECRET`,
`USER_API_KEYS_ENCRYPTION_SECRET`. Wrinkle: the frontend bakes
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` at build time — bake a
placeholder and let the local gateway proxy overwrite the `apikey` header with
the real per-install anon JWT. Zero frontend changes, and we never ship the
well-known demo JWT secret (which would let any local process mint
service_role tokens).

## 3. Phased plan (each phase independently shippable)

### Phase 0 — upstream seams (~1–1.5 weeks, plain web-app PRs behind flags)
1. Land/refresh the **storage adapter** interface (rebase
   `upstream-pr/storage-adapter-gcs` onto current main) + a
   `LocalFilesystemAdapter` (`STORAGE_DRIVER=fs`, `STORAGE_FS_ROOT`), including
   download-token coverage for workflow-reference keys.
2. **Migration runner** — `backend/scripts/migrate.ts` applying
   `backend/migrations/*.sql` with a `schema_migrations` ledger (coordinate
   with PR #338 "resumable migrations"). Compose only applies `schema.sql`;
   the desktop app needs real upgrades.
3. `frontend/next.config.ts`: `output: "standalone"` behind
   `NEXT_OUTPUT_STANDALONE=1`.
4. Optionally revive **demo mode #260** (after #259).

### Phase 1 — local stack supervisor in the shell (~2–3 weeks)
- New `desktop/src/local/supervisor.js`: ordered boot — postgres (first-run
  `initdb` → roles → schema.sql → migrate) → gotrue → postgrest → gateway
  proxy (apikey injection) → backend → next standalone; health-check chain
  mirroring compose `depends_on`; graceful `pg_ctl stop` on quit; logs under
  userData.
- Secrets bootstrap (above).
- Fixed uncommon loopback ports (deterministic because `NEXT_PUBLIC_*` URLs
  are baked); clear error page on port conflict.
- Connect screen (`desktop/src/pages/connect.html` + `mike:*` IPC in
  `main.js`) gains **"Run locally on this Mac"** alongside the server URL;
  `serverUrl()` gains a `local` mode that boots the supervisor then loads the
  local frontend URL. Hosted/self-host modes unchanged.
- Data dir: `~/Library/Application Support/Mike/local/{pgdata,storage,secrets,logs}`
  (the `MIKE_USER_DATA_DIR` test seam already exists).
- Dev mode first: supervisor over repo-built artifacts + Homebrew binaries,
  before packaging.

### Phase 2 — packaging (~1.5–2 weeks)
- `desktop/scripts/build-local-stack.sh`: compile backend, Next standalone
  build, fetch pinned Postgres + PostgREST binaries, build GoTrue for
  darwin/arm64; stage as `extraResources`.
- Signing: every nested Mach-O (postgres, postgrest, gotrue, dylibs) must be
  codesigned with hardened runtime for notarization — extend the existing
  signed-release flow.
- Size budget: Electron ~250MB + backend deps + Next standalone + binaries ≈
  600–700MB installed, DMG ~250–350MB (without LibreOffice).
- Extend `desktop/e2e/flows.e2e.mjs` pattern with a local-mode boot → signup →
  chat (demo mode) → upload/download round-trip.

### Phase 3 — lifecycle & upgrades (~1–1.5 weeks)
- App update ≠ stored stack version → run migrations before serving; pin the
  Postgres major for a long time (major bumps need pg_upgrade/dump-restore).
- Backup: "Back Up Local Data…" menu item (`pg_dump` + tar of `local/`), plus
  the product's existing signed export manifests for per-project export.
- Crash/orphan handling: stale `postmaster.pid` cleanup, port-in-use recovery,
  a "local stack failed" page reusing the connect-screen plumbing.

### Phase 4 — first-run polish (~1 week)
- Local signup (autoconfirm, works offline) → keyless demo answer (#260) →
  banner nudging Settings → API Keys or Ollama.

**Total: roughly 6–9 engineering weeks.**

## 4. Open product decisions

1. **Auth UX** — keep real local login (recommended: zero frontend changes,
   MFA works) vs. auto-created single user (needs an upstreamed "local mode"
   flag in the web app).
2. **Password recovery** without SMTP — accept unavailability in v1, or bundle
   an SMTP sink surfacing mails in-app?
3. **LibreOffice** — detect-only (recommended) vs. on-demand download vs.
   bundle (~+700MB, MPL-2.0 notices).
4. **Demo mode #260** — revive (blocked on #259)? Strongly recommended for
   first-run.
5. Fixed loopback ports vs. proxying everything through one port.
6. Intel support (universal binaries roughly double the native payload).
7. Auto-update ordering vs. DB migrations; multi-account on one Mac; Time
   Machine interaction with a live pgdata dir.

## 5. Critical files / seams

- `desktop/src/main.js` — server-URL/mode selection, connect-screen IPC; where
  the supervisor hooks in.
- `docker-compose.yml` — authoritative service topology, env wiring, and boot
  ordering the supervisor must replicate.
- `backend/src/lib/storage.ts` — storage seam to convert to the adapter
  interface from `upstream-pr/storage-adapter-gcs`.
- `frontend/next.config.ts` — standalone-output flag + the three baked
  `NEXT_PUBLIC_*` vars.
- `supabase/gateway.conf` — the exact routing/CORS contract the Node gateway
  proxy must reproduce.
