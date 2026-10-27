# Error tracking with Sentry

Every Mike runtime can report unexpected failures to [Sentry](https://sentry.io)
(or any Sentry-compatible endpoint, including a self-hosted instance):

| Runtime | SDK | Enabled by |
| --- | --- | --- |
| Backend API process | `@sentry/node` | `SENTRY_DSN` in `backend/.env` |
| Backend worker thread / standalone worker / one-shot jobs | `@sentry/node` | same `SENTRY_DSN` (one project for the whole backend) |
| Web app, in the browser | `@sentry/nextjs` | `NEXT_PUBLIC_SENTRY_DSN` at **build** time |
| Web app, Next.js server (the `/api` gateway) | `@sentry/nextjs` | `SENTRY_DSN` in the frontend's runtime environment |
| Word add-in (task pane, ribbon commands, OAuth dialog) | `@sentry/react` | `REACT_APP_SENTRY_DSN` at **build** time |

**On by default.** Error reports are sent to the Mike project's own Sentry by default, so the
maintainers can fix failures encountered by forks and self-hosted installs.
Before network transmission, every runtime rebuilds reports from an explicit
allowlist: code locations and line numbers, controlled operation labels,
HTTP method/status and normalized routes, validated correlation IDs, release,
and environment. Client document filenames, document text, raw error and
console messages, request URLs/queries/headers/bodies, user identities, and
breadcrumbs are excluded. Automatic sessions, replay, attachments, traces,
and other non-error payloads are blocked. The same boundary applies to
community and official installations. See the [observability guide](observability.md)
for the exact policy, source-map behavior, and limitations.
To opt out, set `SENTRY_DISABLED=true`
(`NEXT_PUBLIC_SENTRY_DISABLED=true` / `REACT_APP_SENTRY_DISABLED=true` for the
browser and add-in builds); to use your own Sentry instead, set the matching
`*_SENTRY_DSN`.

The [data audit](sentry-data-audit.md) preserves the earlier leak findings and
records the final transport boundary that closes them. Internal source-code
filenames identify the failing code; client document filenames are excluded.

Resolution order, per runtime: `*_SENTRY_DISABLED=true` → off;
`*_SENTRY_DSN` set → that DSN; otherwise the built-in Mike project DSN. Backend test
processes (vitest, `NODE_ENV=test`) never report unless
`SENTRY_ALLOW_IN_TESTS=true`. Browser tests disable reporting or use intercepted
transports. Every event carries `install=community` unless
the deployment sets `SENTRY_INSTALL=official` (env, all three runtimes), and
`environment` defaults to `self-hosted`, so the official deployment and the
community are separable in Sentry. The boot log says which applies:
`[sentry] enabled for api → Mike project Sentry (community install). Opt out
with SENTRY_DISABLED=true or point SENTRY_DSN at your own project.`

### Public DSNs and default-on reporting

**Public DSN does not mean public error reports.** A DSN lets an SDK submit
events; it does not grant access to read stored events or administer the
Sentry organization. Mike's default reports go to the maintainers' `open-legal-products`
organization. The source-map upload token (`SENTRY_AUTH_TOKEN`) is a separate,
privileged secret and must never appear in source or browser bundles. See
[Sentry's explanation of public DSNs](https://www.sentry.help/en/articles/13964341-my-dsn-key-is-publicly-visible-is-this-a-security-vulnerability).

There are established precedents, but publishing a DSN and choosing default-on
telemetry are separate decisions. These are applications, not a claim that
installing their underlying libraries automatically reports to their authors:

| Project | What its own source or documentation establishes |
| --- | --- |
| [Zulip Desktop](https://github.com/zulip/zulip-desktop/blob/1cc112def5cd4b0b3ffe15c0857258c527b4421a/app/main/sentry.ts) (Apache-2.0) | Publishes a Sentry DSN. Packaged builds report unless the user disables `errorReporting`; development builds are excluded. |
| [Element Web](https://github.com/element-hq/element-web/blob/5fc4f4090cea4357bf101e051e9864cde7610145/apps/web/element.io/develop/config.json) (AGPL/GPL options) | Publishes a Sentry DSN in its develop deployment configuration. Its [integration](https://github.com/element-hq/element-web/blob/5fc4f4090cea4357bf101e051e9864cde7610145/apps/web/src/sentry.ts) explicitly submits bug reports; this is not evidence of Mike's same automatic reporting policy. |
| [GitLab Service Ping](https://docs.gitlab.com/development/internal_analytics/service_ping/) | Documents default-on telemetry sending a weekly usage payload to GitLab. This is a precedent for default-on usage reporting, not proof of default-on Sentry crash reporting from self-managed instances. GitLab's [Sentry setup](https://docs.gitlab.com/omnibus/settings/configuration/#error-reporting-and-logging-with-sentry) asks administrators to enable it and supply their own DSNs. |

Mike's policy remains explicit: automatic error reporting is on by default,
with the exclusions above, an opt-out, and an alternative destination under
the operator's control. Other projects' choices do not imply identical data
collection, privacy guarantees, or consent policies.

### Quota protection and its limits

Anyone can copy a public DSN and submit junk directly. Local SDK filtering
cannot stop that sender. The controls below protect different things:

| Control | Current implementation / verified state | Limit |
| --- | --- | --- |
| Per-issue burst limit | Backend and shared web/add-in scrubbers allow 10 events per issue key per minute by default, before the quota budget below. Backend override: `SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE`. | Keyed on the raw error text, so varying messages bypass it; the transport budget below is keyed on the final grouping. |
| Quota budget in the final transport | Per issue as Sentry groups it (the diagnostic fingerprint, error type and top frame), only occurrences 1, 2, 4, 8, … are sent, each tagged `occurrence`; the count restarts after an hour without that issue. Each SDK client also sends at most 50 events a day across all issues. Diagnostic test probes skip the per-issue step. A loop failing every second costs about 17 events a day per issue. This replaced a flat 60-a-minute cap, under which one install's stuck poll loops used the whole 5,000-event month in nine hours (2026-09-23). | Per process, worker thread, browser tab, or task pane, so a fleet of installs still adds up. Restarts reset it. Installs built before this change keep the old cap until they update. Does not stop direct submissions to the public DSN. |
| Duplicate and expected-error suppression | Explicit reports mark the same error object to prevent a later console/unhandled duplicate. API 4xx and deliberate client cancellations are excluded from the API reporting paths. | New error objects or independent console messages can still produce events. Grouping several events into one issue does not make them one quota unit. |
| Non-error telemetry | The final transport rejects sessions, transactions, spans, logs, replay, attachments and every other non-error item. | Adding a new telemetry category requires an explicit privacy-reviewed policy change. |
| Sentry spike protection | Enabled on all three projects of the `open-legal-products` organization when checked on 2026-10-20 UTC; no project notification actions are attached. | Uses historical volume; Sentry explicitly says it must not be the sole defense. |
| Inbound filters | The frontend project has browser-extension, crawler, legacy-browser, hydration-error, and chunk-load-error filters enabled; localhost filtering is off (checked on the same date). | Filters can hide genuine bugs too. Custom release/message filters are offered during the Business trial but none are set, and the Developer plan does not offer them; no custom IP blocklist was set on the inspected frontend project. |
| Hard DSN rate limit | The inspected frontend key has no custom limit. The organization was created on a 14-day Business trial (1,000,000 errors) that ends on 2026-11-03; it then falls back to the Developer plan with 5,000 errors per month, where key rate-limit controls are unavailable. | The monthly allowance can be exhausted, leaving genuine new errors unrecorded. |
| Official/community isolation | Separate backend, frontend, and add-in projects; official and community events currently share each runtime's default key/project. | `install=official` is a client-supplied tag, not authentication or a reserved quota. |

These are a dated account audit, not settings enforced by the repository.
Recheck them in Sentry when changing the plan or deploying to another account.
Preventing IP storage is a privacy control, not quota protection. Likewise,
the Next.js `/monitoring` tunnel is not an authenticated abuse barrier; the
public upstream DSN remains usable directly.

For stronger protection, maintainers should:

1. Separate official and community ingestion keys/projects and enforce
   server-side limits for each where the plan supports them. Separate projects
   alone still share the organization's allowance. If using spend allocation,
   understand that it reserves a minimum and can still draw from unallocated
   capacity; it is not automatically a per-project ceiling.
2. Keep spike protection on and configure spike/usage notifications to a
   responsible maintainer. The default per-project email alert for
   high-priority issues is not a quota alert. The owner's personal quota
   notifications (80% and 100%, by email) are on; the spike-protection page
   currently has no project notification actions configured.
3. Set an explicit pay-as-you-go spending ceiling if upgrading to a paid
   plan. A cost ceiling prevents overspending, not loss of error visibility
   when the allowance is consumed. No plan upgrade was made for this audit.
4. Review accepted, filtered, and dropped events in Stats & Usage. Keep noise
   filters narrow; specifically review whether dropping hydration and chunk
   loading failures is appropriate for Mike's supported browsers and deploys.
5. During abuse, disable the affected key, investigate, then rotate and ship
   the replacement. Older installs using the revoked key will stop reporting.
   A replacement public key is discoverable again. Allowed-origin filters can
   reduce unwanted browser traffic, but are not authentication against a
   sender that constructs its own requests.

A controlled ingest service could enforce shared budgets before forwarding,
but that requires an architecture where the upstream credential cannot be
used to bypass it. It is not implemented by the current tunnel. There is no
claim that the current public community endpoint is abuse-proof.

References: [Sentry volume controls](https://www.sentry.help/en/articles/13964888-what-are-some-ways-i-can-control-the-event-volume-for-my-organisation),
[spike-protection limitations](https://www.sentry.help/en/articles/13964833-spike-protection-did-not-work-as-i-would-expect),
and [spend allocation semantics](https://www.sentry.help/en/articles/13964837-understanding-spend-allocation).

## What gets reported

The goal is that a bug shows up as a Sentry issue the first time it happens,
with enough context to reproduce it, and that the same bug groups as one issue
however many users hit it.

**Backend**

- Every unexpected 5xx. All route handlers answer server failures through
  `sendInternalError`, which reports the original error with the mounted
  Express route pattern (`/projects/:projectId`, so one bug is one issue
  however many projects it hits), the HTTP method, the status, and the
  `request_id` that the client receives in the response
  body and the `X-Request-ID` header (exposed to cross-origin scripts). A handler that
  writes its own 5xx body is caught by the response sanitizer and reported as
  a message.
- Model streams that fail after the response has started (the 500 path never
  sees these). Deliberate, explained refusals (`UserFacingError`: missing API
  key, disallowed model) are not bugs and are not reported.
- Background jobs: every failed attempt of a `db_jobs` job (warning while
  retries remain, error when exhausted), failure-hook crashes, unknown job
  kinds, claim/tick/retention failures, BullMQ conversion/extraction/delivery
  failures, upload-session processing and conversion failures, worker
  heartbeat and loop failures, and the maintenance sweeps.
- Playbook reviews and imports (`component=playbooks`, split by `stage`:
  `import.read` … `import.save`, `review.model`, `review.apply_edits`,
  `review.save`, `heartbeat`, the `*.record` writes of a failure, staged
  upload cleanup, and `job.terminal` for an in-process job with the runner
  off). Tags add `job_kind` and, for imports, `file_type`; `extra` holds only
  `run_id`, `import_id`, and `playbook_id`. Refusals the user is shown (a bad
  file, a missing or rejected key, no access) are not reported; model output
  still invalid after the automatic recompile, timeouts, and provider errors
  are warnings; crashes and storage or database failures are errors.
- Process lifecycle: boot configuration failures, worker-thread crashes and
  respawns, graceful-shutdown errors, workflow-sync job failures. Unhandled
  promise rejections are reported and then still exit the process, exactly
  as Node does with reporting disabled; enabling Sentry never changes how
  the process lives or dies.
- Best-effort work that must not fail its caller but must not vanish either:
  storage deletes during rollbacks, cancelled uploads, and expiry sweeps go
  through `deleteFileBestEffort(key, stage)` and are reported as warnings
  grouped by stage. Use `bestEffort(promise, { what })` for the same shape
  elsewhere instead of `.catch(() => {})`.
- Everything else that reaches `console.error`, via Sentry's console bridge.
  The same error object already reported explicitly is recognised and not
  sent twice; unrelated console messages do not share that identity.
- Node's own process warnings (`DeprecationWarning`, `ExperimentalWarning`,
  `MaxListenersExceededWarning`, …), as warnings tagged
  `component=runtime-warning` with `warning_name` and, for deprecations, the
  `warning_code` (`DEP0040`), grouped per name and code. Node prints these
  through `console.error` from its own internals, so through the bridge alone
  they arrived as a context-free "Failure in application"; the printed copy is
  now dropped and the warning object, whose stack names the module that
  raised it, is reported instead. `--no-warnings` silences this too.

Backend events carry `service=mike-backend` and `role` (`api`, `worker`,
`worker-thread`, or `job`); explicit reporting paths add `component`.
User identity is removed by the final transport in both installation modes.

**Web app**

- Uncaught exceptions and unhandled promise rejections in the browser (SDK
  default), the route error boundary (`error.tsx`), and the root boundary
  (`global-error.tsx`).
- Every backend 5xx seen by the API client, with a controlled title containing component, method, route and status with the backend's `request_id` — search `request_id:<id>` in Sentry
  to see both halves of one failure. 4xx are intentional answers to user input
  and are shown, not reported.
- Requests that never reached the server (backend down, mid-deploy, network),
  as warnings grouped per endpoint rather than one "Failed to fetch" issue.
  Deliberate cancellation (an aborted signal or `AbortError`) is not reported.
- Assistant chat streams that fail for a reason other than the user stopping
  them.
- Server side: gateway failures to reach the backend, and render/route-handler
  errors through Next's `onRequestError` hook.
- Everything else that reaches `console.error`, deduplicated as above. An
  error reported explicitly is also not filed a second time if the same
  object then escapes to the browser's unhandled-error or rejection handler.

**Word add-in**

- Uncaught errors in the pane, plus a React error boundary around the whole
  pane that shows a "Try again" fallback instead of a blank pane.
- Backend 5xx (with `request_id`), transport failures that never reached the
  server (warning level, grouped per endpoint: the most common failure users
  see in Word and the hardest to diagnose), mid-stream chat failures, and
  tool-result delivery failures.
- Office.js failures while reading, anchoring, resolving, restoring, or
  revealing a tracked change (`component=word-office`, grouped by `stage`
  and by Word's own error code). Documented stale-proxy fallbacks that the
  code retries are control flow and are not reported.
- Office host tags (`office_host`, `office_platform`, `office_version`) so a
  bug that only reproduces in Word on Mac 16.x or Word on the web is
  identifiable.

## Outbound privacy boundary

`sendDefaultPii: false` and the original `beforeSend` scrubber provide defense
in depth, but neither is the final guarantee: SDK session items bypass
`beforeSend`. `privacyBoundaryIntegration` wraps the installed SDK transport
and rebuilds the complete envelope before serialization. It is installed in
the backend, Next server/edge, browser, and all Word add-in entries.

- Only error `event` items may leave. Sessions (including authenticated `did`),
  client reports, attachments, replay, traces, logs, metrics and unknown future
  item types are dropped locally without a network request.
- Error/console prose is replaced with a description made from approved
  operation, component, stage, error-kind, method, normalized route, status,
  and error-code values. For example:
  `Failure in documents.upload.complete / upload-worker / process-file / conversion.no_output`.
  Static exception constructor names, relative source-code locations and
  function names on our own frames remain. Before serialization, the
  reporter checks exception types against the actual Error constructors in
  the cause chain; an SDK's mutable `Error.name` is not evidence of a class
  name. Node's fixed warning categories are also retained. Function names
  are trusted under the source contract below, with dependency frames
  excluded even when `node_modules` sits inside an application directory.
- Request data, headers, cookies, URLs and queries are absent. Routes retain
  only fixed endpoint vocabulary; other segments become `:id`.
- User objects, machine details, arbitrary contexts, source snippets, frame
  locals, custom tags and free-form extras are absent. Of breadcrumbs only
  the stage trail survives (`markStage`, category `mike.stage`): static stage labels, with timestamps, never a message or data. Correlation/domain IDs are allowed only under named keys and
  only in UUID format. IDs remain linkable to internal records; this is data
  minimization, not a claim of anonymity.
- Finite failure codes, dependency HTTP status, storage operation, file type,
  capture source, build mode and `diagnostics_version` remain. Wrapped and
  aggregate causes and AI SDK `lastError` are inspected locally with bounded
  traversal. Known provider error classes become a finite `provider_error`
  category; response bodies, prompts and credentials are never retained.
  Browser fetch failures include only `network_state` (online/offline/unknown)
  and `request_origin` (same-origin/cross-origin/unknown), never the hostname.
  Online means the browser reports connectivity, not that a server is reachable. Arbitrary
  codes/names/messages and dependency metadata are not transmitted.
- Invalid configuration reports may name approved environment **fields**, never
  their values. Converter failures distinguish missing binary, timeout and
  nonzero exit without sending stderr or document paths.
- Browser/runtime contexts retain only approved software names and numeric
  versions; user-agent strings, device identity and other context fields are
  excluded. Message captures explicitly request stacks; the same path-only
  filtering applies to those frames.
- Opt-in pipeline probes carry `diagnostic_test:true` and a controlled test
  title so they can be separated from real failures.
- Controlled Office host/platform/version tags remain. Source-map debug IDs
  and code-file locations remain so uploaded source maps can resolve frames.
  Source-map uploads themselves are a separate operator-enabled transfer of
  application source code.
- The same restrictions apply to `install=official` and `install=community`.
  An install label does not enable transmission of client information.

Do not put customer names in operator-supplied release/environment values.
Those values identify the deployed software and are sent with reports.
Performance tracing settings do not bypass the error-only transport boundary;
tracing is unsupported until a separate outbound policy is reviewed.

The boundary is mirrored in `backend/src/lib/observability/sentryPrivacy.ts`
and `frontend/src/shared/lib/sentryPrivacy.ts`, with a synchronization test.
When adding diagnostics, extend reviewed enum/ID fields and their tests. Do not
add free-form text just to restore a more detailed exception message.

## Configuration

Backend (`backend/.env`, read at process start):

```
SENTRY_DISABLED=false                  # true = send nothing
SENTRY_DSN=                            # your own Sentry; empty = Mike project Sentry
SENTRY_INSTALL=                        # "official" only on Mike's own deployment
SENTRY_ENVIRONMENT=production          # defaults to self-hosted
SENTRY_RELEASE=mike@1.4.0              # optional; defaults to mike@<git sha>
SENTRY_TRACES_SAMPLE_RATE=0            # optional, 0..1
SENTRY_ENABLE_TEST_ROUTE=false         # see "Verifying" below
```

Do not add `SENTRY_DSN` to the `environment:` block of the backend service in
`docker-compose.yml`: that block overrides `env_file`, and an unset host
variable would blank the value from `.env`. Put it in `backend/.env` or the
compose-root `.env`.

Web app. The browser DSN is inlined by `next build`, so for the Docker image it
is a build argument; the Next server reads its own DSN at runtime:

```
# root .env (Docker Compose)
FRONTEND_SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=mike@1.4.0

# or, building the frontend directly
NEXT_PUBLIC_SENTRY_DISABLED=true       # browser opt-out (build time)
NEXT_PUBLIC_SENTRY_INSTALL=official    # only on Mike's own deployment
NEXT_PUBLIC_SENTRY_DSN=...             # browser (build time)
NEXT_PUBLIC_SENTRY_ENVIRONMENT=...     # optional
NEXT_PUBLIC_SENTRY_RELEASE=...         # optional
SENTRY_DSN=...                         # Next server (runtime)
```

Use a separate Sentry project for the web app and the backend: separate issue
streams, separate source maps, and the frontend DSN is public in the bundle.

### Releases

Every event carries a release so Sentry can flag a regression in a deploy and
resolve an issue "until the next release". Set `SENTRY_RELEASE` explicitly, or
leave it unset and build with the commit hash; the images then tag events
`mike@<sha>`:

```bash
GIT_SHA=$(git rev-parse HEAD) docker compose build
```

`GIT_SHA` is a build argument for all three images, never a runtime variable.

Word add-in (build time, `word-addin/.env` or the Docker build arguments):

```
REACT_APP_SENTRY_DISABLED=true         # opt-out
REACT_APP_SENTRY_DSN=...               # your own Sentry; empty = Mike project Sentry
REACT_APP_SENTRY_ENVIRONMENT=...       # optional
REACT_APP_SENTRY_RELEASE=...           # optional
```

### Readable stack traces (source maps)

Production bundles are minified. To see real file and line numbers in Sentry,
provide upload credentials at build time; the build then uploads source maps
and deletes them from the output so they never ship:

```
SENTRY_AUTH_TOKEN=...   # organization token with Source Map Upload permission (org:ci)
SENTRY_ORG=...
SENTRY_PROJECT=...
```

Applies to `next build` (frontend) and `webpack --mode production` (add-in).
Without all three variables the build is unchanged and nothing is uploaded.
The backend needs no upload: `tsc` emits source maps next to the compiled
files and the process runs with `--enable-source-maps` (the `start` script,
and `NODE_OPTIONS` in the Dockerfile), so backend frames already read
`src/lib/x.ts:line`.

## Verifying a deployment

1. Set a local or deployment-owned DSN and restart. The backend logs
   `[sentry] enabled for api (environment ...)` for an explicit DSN. An unset
   DSN uses Mike's project and logs that destination; only
   `SENTRY_DISABLED=true` (or the test-process guard) disables reporting.
   Rebuild browser bundles after changing their `*_SENTRY_*` variables.
2. Backend: set `SENTRY_ENABLE_TEST_ROUTE=true`, restart, and run

   ```bash
   curl -i http://localhost:3001/observability/sentry-test
   ```

   You get a 500 with a `request_id`; the Sentry issue carries the controlled HTTP failure title and the same
   `request_id` tag. Turn the flag off again: the
   route is unauthenticated and exists only to prove the pipeline.
3. Web app: open the app, and in the browser console run
   `setTimeout(() => { throw new Error("Sentry web test") })`. The error
   arrives tagged `service=mike-frontend runtime=browser`. To see the
   request-id correlation, stop the backend and click anything that loads
   data: the browser reports the normalized route and status 502 and the Next server reports
   the gateway failure.
4. Word add-in: with the DSN baked in, open the pane and stop the backend; the
   next action reports a transport-failure warning with the Office host tags.

### Without a Sentry account

`scripts/sentry-sink.mjs` is a dependency-free local stand-in for Sentry's
ingest endpoint. It accepts the same envelope protocol the SDKs speak, prints
each event, and serves them at `http://localhost:9999/`:

```bash
node scripts/sentry-sink.mjs
# then, in the runtime you want to check:
SENTRY_DSN=http://mike@localhost:9999/1              # backend
NEXT_PUBLIC_SENTRY_DSN=http://mike@localhost:9999/2  # web app (browser)
REACT_APP_SENTRY_DSN=http://mike@localhost:9999/3    # add-in
```

The project number is arbitrary; it only appears in the ingest path. This is
also how the Word add-in's Playwright suite tests reporting
(`word-addin/e2e/error-reporting.spec.ts`): the e2e bundle carries a DSN for a
host that does not exist and the tests intercept the envelope.

## Adding reporting to new code

### What makes an actionable error

An issue should let a maintainer answer: what operation failed, where it
failed, which release/runtime was running, whether recovery succeeded, and
which request or job connects the evidence. Preserve the original exception
and stack; add context rather than replacing it with `new Error("Failed")`.

For example, an API issue with method `POST`, status `500`, and route `/projects/:id/...`
identifies the user-visible symptom. Its `request_id` links to the backend
exception and stack, which explain the cause. An Office issue uses `stage`
and `office_code` to identify the failing Word operation. Retryable job
attempts are warnings; exhausted attempts are errors. These fields make an
issue useful even when its exception title is a generic provider message.

The transport keeps a restricted set of fields. Application labels are
authored in code and **do not require a central registration list**. Use
short lowercase labels separated by dots, underscores or hyphens; the syntax
check is defense in depth, not a test for PII. Two labels identify a failure:

- `operation`: the user-level flow a request or job belongs to
  (`documents.upload.complete`, `chat.turn`, `playbooks.import`). Set it once
  at the entry with `setOperation(...)` in the backend, or pass `operation`
  to the client reporters; every event captured until the request or job
  finishes carries it, and it leads the title and the fingerprint. The default stack grouping remains, so different failure sites
  within one operation can still be separate issues.
- `error_kind`: what went wrong, from the code that threw. Throw an
  `AppError` (or a subclass: `StorageOperationError`, `AssistantStreamError`,
  `DbJobDeferredError`, `NonRetryableJobError`) with a kind such as
  `conversion.no_output` or `chat.provider_rate_limited`; the boundary reads
  the deepest application-authored kind on the cause chain, so a wrapper's kind never hides the
  cause's. `withKind` in `appError.ts` preserves an Error already carrying a
  named cause. Wrap a dependency's error as the cause
  rather than re-throwing a bare `new Error(...)`: its errno, SQLSTATE,
  PostgREST or AWS code and HTTP status already extract as `failure_code`
  and `dependency_status`.
- `markStage("seal-recover")` records the stages a request passed through as
  its breadcrumb trail, so a throw reached via one path is distinguishable
  from the same throw reached via another.

Raw error messages still do not leave the process in either install mode.
The kind and operation provide a safe, descriptive identity without requiring
a second list to be edited. `AppError` stamps its kind with a non-enumerable
local marker; a dependency's arbitrary `kind` property is never adopted.
Dependency messages, response bodies and credentials remain local, while
approved technical codes and numeric statuses can be extracted from causes.

### Source contract for diagnostic identity

- Give errors static class names. Do not derive `Error.name`, class names or
  function names from a customer, document, request or upstream response.
- Write operation, kind, stage, component and job labels in code. A fixed map
  selected by runtime state is fine; interpolating runtime data into a label
  is not. New labels and application error subclasses need no registration.
- Wrap upstream failures with `new AppError("feature.step_failed",
  "Step failed", { cause })`. Preserve the cause for technical classification;
  never copy its prose into diagnostic labels or extras. The message remains
  local and is not treated as safe to transmit merely because it is an AppError.
- `backend/src/__tests__/diagnosticVocabulary.test.ts` parses production
  TypeScript/TSX across all three applications. It rejects common dynamic-name
  and label mistakes. This is a coding contract backed by CI and review, not
  whole-program taint analysis: helper parameters and fixed mappings still
  need review for their origin.
- Real-SDK transport tests cover both install modes, including new unregistered
  labels, dependency-provided names/kinds, cause payloads and automatic captures.

### Client reporting contract

- `describeError`, `userFacingApiError` and the add-in's `userMessage` only
  classify or format a failure. They never capture an event. For an inline
  error, call `reportFault(error, { operation, ...descriptionOptions })`;
  it reports eligible faults and returns the description to render.
- `notifyError` reports and presents an eligible failure. Partial-failure
  notices can report their underlying cause, while their user-facing summary
  stays out of telemetry.
- Typed API wrappers pass their static operation into `apiRequest` before
  the request begins. API 5xx reports are captured immediately with that
  operation; there is no pending-report timer or later screen claim. A
  delayed screen handler cannot change or lose the operation on the event.
- Reporting callers and automatic captures consult the same error registry.
  Reformatting an already-reported failure does not create another event.
- Terminal stream frames use `reporting_owner: "backend"` when the backend
  owns reporting. This does not promise delivery to Sentry. Clients preserve
  that ownership and avoid duplicate reports. A request ID is only for
  correlation: older frames without an ownership field retain client-side
  fallback reporting, even when they have a request ID.

Use `withKind` to wrap a failure only when its cause chain has no application
kind. Domain helpers may build result objects or apply domain-specific policy,
but delegate kind preservation to that helper. `ConversionError` derives its
legacy consumer code from its diagnostic kind; callers do not supply both.

Example (no registry update):

```ts
setOperation("documents.compare");
markStage("load-revisions");
throw new AppError("comparison.source_read_failed", "Could not read revision", { cause });
```

For each new reporting path:

- Use a static operation/component and stage, plus a stable error kind or
  code. Keep request/job IDs out of the title and grouping fingerprint.
- Retain safe diagnostic IDs and the original stack. Check the scrubber's
  allowlist before assuming a new `extra` field will survive transmission.
- Set release metadata and upload matching browser/add-in source maps in
  every deployment build; one successful upload does not configure future
  builds. Without maps, minified frames are much less useful.
- Test a synthetic failure through the real path and inspect the outgoing
  event. Assert both useful context and absence of sensitive content.
- Configure an owner and a useful notification. Delivery to a recently active
  member is not the same as assigning the issue to a responsible team.

Sentry detects failures on instrumented paths; it cannot discover every
incorrect result or silently swallowed exception. Console capture is a
fallback; its free-form label is omitted, so add static component/stage context at the call site.
The client 5xx fingerprint groups symptoms by endpoint/status, so investigate
the correlated backend events before assuming one symptom has one cause.
Throttling, filters, and delivery failures also mean Sentry's event count is
not an exact count of every failure experienced by users.

### Reporting helpers

- Backend: throw, or call `sendInternalError(res, err)` — both paths report.
  For background work that must not throw, call `reportError(err, { tags:
  { component: "...", ... }, extra: {...} })` from
  `backend/src/lib/observability/sentry.ts` **before** the accompanying
  `console.error`, so the console bridge recognises it as already sent. Use
  `level: "warning"` for failures that will be retried automatically.
- Web app: `reportError` / `reportApiFailure` from
  `frontend/src/app/lib/errorReporting.ts`. Do not import `@sentry/nextjs`
  in feature code.
- Word add-in: the same helpers from `word-addin/src/taskpane/lib/errorReporting.ts`.
- Tags are indexed and filterable; keep them low-cardinality (a component
  name, a job kind, a status). Ids go in `extra`.
- Never put document text, prompts, file names from user uploads, or email
  addresses in error messages, logging labels, or reporting context. Keep the
  first console argument a static diagnostic label. Raw console arguments
  and `body` fields are excluded; additional positional strings are not used
  in event titles or grouping keys. Attach safe diagnostic ids explicitly.
  The final transport discards raw error prose rather than guessing which
  parts are private. Source logs should still avoid privileged information.

Unknown database-queue job kinds use `operation=jobs.dispatch` inside the
same per-job isolation scope as normal handlers. Their
`error_kind=dbq.unknown_job_kind` identifies the dispatch failure; destructive
cleanup kinds retain their retry-until-success policy during rolling upgrades.
