# Sentry open-issue review — 2026-09-23 UTC

Snapshot: `mike-xp`, `is:unresolved`, 90-day window, all projects, limit 100.
The latest refresh returned 28 issues (14 backend, 14 frontend, none in the
Word add-in): 24 non-test issues and four historical synthetic/probe issues.
This extends the previous 20-issue review with BACKEND-B/C/D/E and
FRONTEND-B/C/D/E.
Every issue's details were inspected. The newest events use `self-hosted`;
that label alone does not establish whether an installation is production.
No issue was resolved or suppressed as part of this review.

The historical reports omit information needed to establish application root
causes. The changes fix reproduced telemetry defects and add diagnostics for
future recurrences. They do not claim that a deployment/network/conversion
failure was repaired, and cannot recover previously removed data.

## Outcome of the review

Updated after the application-fix round of 2026-09-23 (same day, second pass):

- **10 application defects fixed**, covering 19 issue groups. One commit per
  fix, each with a regression test that fails without it:
  BACKEND-2 (`ffc4a7ae`), BACKEND-3 duplicate (`3c957364`), BACKEND-7
  (`4e57bbf8`), BACKEND-B/C/D/E (`d3fd1623`), FRONTEND-C (`30bfee33`),
  FRONTEND-B/D/E (`813ecd02`), FRONTEND-4/5/8 operator log (`a5374b28`),
  BACKEND-A/FRONTEND-A reporting (`cfbb1509`), BACKEND-5/6 (`611589f5`),
  BACKEND-9 (`03e8acf1`).
- **BACKEND-A / FRONTEND-A**: the reporting defect is fixed (a PostgREST
  plain-object error now arrives with a stack at the service boundary and its
  code); the application cause is narrowed to a single-segment GET on
  `/audit`, `/quick-actions`, `/tabular-review` or `/workflow-addons` on an
  install whose database is behind its code, and the next event will name it.
- **BACKEND-8 / FRONTEND-7**: an unreachable object store on the sending
  install; documented in `docs/deployment.md`, not a code defect.
- **FRONTEND-6, FRONTEND-9**: not replicable from the available evidence.
- **4 issues are synthetic test events** (BACKEND-1, FRONTEND-1/2/3).

The two diagnostic fixes below (stack locations, provider causes) still stand;
the dispositions table further down describes what each group's next event
carries. All of this is in
[PR #525](https://github.com/open-legal-products/mike/pull/525).

## Confirmed diagnostic fixes

A real-SDK test reproduced the loss of nested console Error stacks in community
mode: the first scrubber made paths repository-relative, then the final parser
rejected those relative paths. The fix accepts sanitized locations, preserves
already-relative exception paths, and emits console frames oldest first. The
same test retains code locations and excludes synthetic private text in both
install modes. See [PR #525](https://github.com/open-legal-products/mike/pull/525).

A second regression reproduced loss of provider causes through the safe error
wrappers: API-key/access errors and `AssistantStreamError` discarded the
original error/status. The fix preserves non-enumerable `cause` internally;
stream events still contain only the existing safe message and code. This is
a separate commit in #525. It repairs diagnosis, not a rejected credential.

## Issue dispositions and next-event evidence

Each row identifies the evidence needed to choose a real fix after deployment.
Related issues are grouped only where their reported operations match; a shared
component is not proof of a common root cause.

| Open issue(s) | What the current evidence establishes | New diagnostics / next decision |
| --- | --- | --- |
| [BACKEND-B](https://mike-xp.sentry.io/issues/MIKE-BACKEND-B) | Chat route reports an `AssistantStreamError`; the original cause was lost. Shares a request ID with C/D/E. | Fix #525 preserves the original cause through the stream wrapper. Reporting extracts controlled provider category/status and known inner network codes without chat content. Correlate the request before treating the four reports as separate root causes. |
| [BACKEND-C](https://mike-xp.sentry.io/issues/MIKE-BACKEND-C), [BACKEND-D](https://mike-xp.sentry.io/issues/MIKE-BACKEND-D) | Google provider response-handler failures in streaming and nonstreaming AI SDK calls. HTTP status and response details were removed. | `provider_error:api_call` or `retry_exhausted`, numeric `dependency_status`, and bounded `lastError` traversal distinguish rejection, rate limits and provider outages. No response body, prompt, key or arbitrary model ID is transmitted. |
| [BACKEND-E](https://mike-xp.sentry.io/issues/MIKE-BACKEND-E) | Stack reaches the explicit invalid-API-key mapping. Credential rejection is established; deployment key versus user-supplied key is not. | Fix #525 preserves the rejected API call as the internal cause. Reporting retains `provider_error:invalid_api_key` and numeric status. A credential/configuration correction may be needed; this PR does not claim to repair a rejected key. |
| [FRONTEND-B](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-B), [FRONTEND-C](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-C), [FRONTEND-D](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-D), [FRONTEND-E](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-E) | Repeated fetch TypeErrors for an obscured root endpoint, models, chat and projects. The browser did not provide an HTTP response. | Preserve approved root/model endpoint vocabulary, exact fetch-failure category, browser/version and code stack. Add bounded `network_state` and `request_origin` to distinguish offline/same-origin/cross-origin failures without hosts or URLs. Browser “online” does not prove server reachability; opaque fetch errors cannot distinguish CORS from TLS/DNS by themselves. |
| [BACKEND-A](https://mike-xp.sentry.io/issues/MIKE-BACKEND-A), [FRONTEND-A](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-A) | New matching GET 500 reports share a request ID. The backend stack points to service-failure handling and the reporter wrapper; endpoint and original cause were removed. | Retain approved Express mount names instead of `/:id`, preserve non-Error throwable causes when wrapping them, and extract only known codes/status. A synchronization test checks that every Express mount survives route sanitization. |
| [BACKEND-2](https://mike-xp.sentry.io/issues/MIKE-BACKEND-2) | Fatal startup configuration path; no stack or reason. | `runtime-config` versus `manifest-key`, controlled failure code, and invalid configuration **field names**, without their values. Distinguish missing/invalid auth configuration from signing-key configuration. |
| [BACKEND-3](https://mike-xp.sentry.io/issues/MIKE-BACKEND-3), [BACKEND-4](https://mike-xp.sentry.io/issues/MIKE-BACKEND-4) | Generic application message/exception; cause unknown. | Capture source, restored nested-console stack, message call-site stack, allowlisted cause codes and numeric dependency status. Use the first application frame and any request ID to locate the failing operation. |
| [BACKEND-5](https://mike-xp.sentry.io/issues/MIKE-BACKEND-5) | Best-effort storage cleanup failed during seal recovery. | `storage_operation:delete`, existing `seal-recover` stage, AWS/system cause code and dependency status distinguish permissions/configuration from connection or service failure. Never send object keys. |
| [BACKEND-6](https://mike-xp.sentry.io/issues/MIKE-BACKEND-6) | Best-effort storage cleanup failed during session expiry. | Same bounded storage diagnostics with `session-expiry`, retaining worker role and source location. Compare causes before assuming it shares BACKEND-5's root cause. |
| [BACKEND-7](https://mike-xp.sentry.io/issues/MIKE-BACKEND-7) | Graceful shutdown catch; no failing sub-operation. | `shutdown-http` versus `shutdown-workers`, code such as `ERR_SERVER_NOT_RUNNING`, and source stack. Use these to determine whether closure is benign/already complete or a real shutdown failure. |
| [BACKEND-8](https://mike-xp.sentry.io/issues/MIKE-BACKEND-8), [FRONTEND-7](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-7) | Upload completion 503; the two events share a request ID. The service maps `StorageOperationError` to this response. | Preserve storage wrapper operation, bounded cause code/status, and the existing shared request ID. Distinguish HEAD/copy/download failure from storage access or network problems. |
| [BACKEND-9](https://mike-xp.sentry.io/issues/MIKE-BACKEND-9) | Upload conversion warning; no reason. | `conversion_unavailable`, `conversion_timeout`, `conversion_failed`, or an allowlisted OS error, plus controlled file type and source location. Determine installation failure versus hung/rejected conversion; never send stderr, filenames or document bytes. |
| [FRONTEND-4](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-4) | Gateway fetch failed with a nested aggregate cause; its codes were removed. | Inspect wrapped/AggregateError causes for known network/TLS codes. Gateway stage separates configuration, fetch and response construction. Safe route, 502 status and a generated request ID correlate both sides. |
| [FRONTEND-5](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-5), [FRONTEND-8](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-8) | Browser saw 502s on project/upload-session requests; no gateway correlation ID. The project endpoint name was also removed. | Gateway responses now return the same generated UUID reported server-side. Controlled project route vocabulary distinguishes directory/people/access/memory. Correlate the browser symptom to the gateway's actual cause. |
| [FRONTEND-6](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-6) | Unhandled TypeError in React server-component development chunks; raw error removed. | Exact known fetch-error messages map locally to `fetch_failed`; other messages stay excluded. Known browser/runtime name and numeric version, build mode, capture source, code stack and release help reproduce. Do not assume every TypeError is a network error. |
| [FRONTEND-9](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-9) | Generic browser message without call site. | Message call-site stacks and repaired nested-console stacks, capture source and controlled cause codes identify the emitting code. |
| [BACKEND-1](https://mike-xp.sentry.io/issues/MIKE-BACKEND-1), [FRONTEND-2](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-2) | Intentional `/observability/sentry-test` failures. | New opt-in probes are labeled `diagnostic_test:true` and titled `Diagnostic test …`, so verification can be separated from real incidents. The test route remains opt-in. |
| [FRONTEND-1](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-1), [FRONTEND-3](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-3) | Explicit synthetic browser/source-map proof events from earlier verification. | No application bug is demonstrated. Record as historical verification; the temporary proof page is not in the current tree. No blanket filter hides unhandled browser errors. |

## Review after 24 hours on the deployed changes

1. Merge the combined diagnostic fixes and reporting changes in PR #525. Deploy the
   backend API/workers and rebuilt web/add-in bundles. Use the existing release
   configuration to identify the deployment. No deployment is performed by
   this PR.
2. Select the last 24 hours and `diagnostics_version:2` in Sentry. This avoids
   mistaking historical, pre-change events for new diagnostics, even if a
   self-hosted install omits its release tag. Separate `diagnostic_test:true`
   events. Inspect new groups too: improved cause-based fingerprints can split
   an old generic issue into several actionable issues.
3. For each recurrence, record service/role/build mode/release, operation and
   stage, failure code/provider category/dependency status, browser network state
   and origin relation, safe code location, and any request
   ID. Use the table above to select a synthetic reproduction and the smallest
   regression test. A gateway-generated ID identifies its failure response;
   it is not an upstream distributed trace ID.
4. Compare occurrences by operation and cause. Do not close an old incident
   solely because its former fingerprint stopped receiving events. If there
   is no recurrence, record “no new evidence”; one quiet day does not establish
   that the underlying defect is fixed.
5. Unknown provider errors remain private and may still need an additional
   finite reason code at their source. This design aims to make the next day
   useful; it cannot guarantee a diagnosis without recurrence or make arbitrary
   third-party prose safe to transmit.

The final transport still rejects non-error telemetry and all raw prose,
request bodies/headers/URLs, user objects, breadcrumbs, source snippets and
arbitrary metadata. New fields are finite vocabulary, constrained numeric
values, approved software versions, or existing UUID correlation fields.
No production document or live Sentry test event was used for verification.
