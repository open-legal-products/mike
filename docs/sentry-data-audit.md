# Sentry data audit

## Current policy after the audit fixes

The final transport boundary now applies the same explicit allowlist in all
runtimes and both installation modes. Only error events are transmitted.
Automatic sessions (including user IDs), client reports, replay, attachments,
traces, logs, metrics and unknown envelope types are dropped locally.

Error values and console labels are replaced with controlled diagnostic
descriptions. Request URLs, query strings, all headers, bodies, user objects,
breadcrumbs, arbitrary context, free-form extras, function names, local
variables and source snippets are omitted. Source-code paths/line numbers,
source-map debug IDs, approved operation tags, UUID correlation/domain IDs,
release/environment and severity remain. Bounded cause codes, provider error categories/status, browser network state
and origin relation (never hosts), operation stages,
approved configuration field names (never values), broad software names/numeric
versions and capture provenance also remain; see the
[2026-09-23 issue review](sentry-issue-review-2026-09-23.md). Client document names have no
permitted outbound field. Domain IDs remain linkable to internal records.

The real Node SDK was exercised against a local capture server in community
and official modes: filename and authenticated-user canaries were absent,
only error items were sent, and request correlation survived. Tests also
cover space-containing, extensionless and Unicode private names, unknown
SDK fields, mixed envelopes, and the 60-event/minute runtime-wide limit.

These changes intentionally reduce diagnostic prose: a raw provider or
database error may quote privileged content. Use the retained source location,
operation, status/code and request ID to investigate. Source-map uploads
remain a separate opt-in transfer of build artifacts. Operator release and
environment names must not contain customer information.

See [the outbound policy](observability.md#outbound-privacy-boundary) and
[quota limits](observability.md#quota-protection-and-its-limits). Public DSNs
remain susceptible to direct abuse; local budgets are not an ingest firewall.

## Historical audit: before the final transport boundary

The remainder preserves the original findings for traceability. It describes
the earlier commit, not the current outbound payload.


Audit date: 2026-09-22 UTC. Audited PR #450 code at `36ef6450` (same runtime
implementation as `abf21c8d`, which produced the captured live envelopes).
SDK version: 10.73.0. This records the earlier behavior and then-unresolved gaps; it
does not certify that no sensitive information can leave the application.

## Scope and conclusion

The integration does not enable screen recording, session replay, screenshots,
or document attachments. It does send more than exception events: default
SDK integrations also send session-health data and delivery statistics.
Source-map uploads separately send application build artifacts/source code
when upload credentials are configured.

**The community privacy boundary is incomplete.** Error-event minimization
does not cover session envelopes. A signed-in user's application ID can be
sent in a session's `did` field. Ordinary query values and arbitrary text
also survive in several event fields. These need resolution before promising
that reports cannot identify users or contain customer content.

This audit inspected current source, the installed SDK, earlier synthetic
outgoing envelopes, and local synthetic probes. No customer data was used,
no new events were transmitted to Sentry, and runtime settings were not
changed. Earlier live captures used the real API and browser helpers, but
were not a complete authenticated production/Office-host exercise.

## What leaves the runtime

Fields depend on the reporting path and SDK. This table distinguishes actual
captured data from fields permitted by code.

| Category | Fields / examples | Evidence and privacy implications |
| --- | --- | --- |
| Error description | Exception type/message, severity, handled/unhandled mechanism, static console label | Observed. Credential/email patterns are filtered, but ordinary prose is retained. |
| Code location | File/module/function, line/column, in-app marker, nearby source-code lines | Observed in the backend event. Community exception frames use relative paths; in-app source snippets remain. A custom fork's code or hardcoded literals may therefore leave the machine. |
| Operation | HTTP method/status/route, transaction name, component, stage, error code, job kind, worker role | Observed HTTP fields; other fields depend on the call site. Normalized route tags do not guarantee that every URL or transaction field is normalized. |
| Correlation | Event ID, request ID, trace/span IDs, grouping fingerprint | Observed. These link reports. They are not proof that the dataset is anonymous. |
| Domain identifiers | Document/file/job/review/row/session/tool-call/version/worker IDs, bookmark names, stable edit IDs | Allowed when explicitly attached; not all were present in the synthetic capture. Values can be linked to internal records and some names may themselves reveal information. |
| Software context | Release/commit, environment, service/runtime, SDK name/version/integration list, OS/runtime/browser versions; Office host/platform/version when available | Release/runtime/SDK/OS observed. Office fields verified in code. Dependency/module metadata may also be attached by SDK defaults. |
| Request URL | Path and potentially ordinary query values; community removes origin | Observed path; synthetic probes confirmed that `?q=SYNTHETIC_SEARCH_TEXT` survives while `token=` is filtered. |
| Session health (`session`) | Random session ID, start/update timestamps, status, error count, release/environment, user-agent; duration where applicable | Observed in both backend and frontend traffic. Not a recording. These messages can be sent without an error and are not processed by the error `beforeSend` hook. |
| Session user identifier (`did`) | Signed-in application user ID | Real-SDK local reproduction confirmed it survives session serialization while the error-event user is removed. The unauthenticated earlier live sample did not contain this field. Web and Word auth code call `setReportingUser`, and the browser SDK updates session identity from the scope user. |
| Aggregate session health (`sessions`) | Time bucket, counts of exited/errored/crashed sessions, release/environment | Observed in backend traffic. |
| Delivery report (`client_report`) | Timestamp, discarded-event reason/category/count | Observed in backend traffic, including sampling and `before_send` drops. No exception text in this captured item. |
| Envelope metadata | Submission timestamp, SDK, routing identifiers, release/environment and trace sampling metadata when present | Observed outside the error payload; not governed by that payload's scrubber. |

### Community versus official error events

Anything other than an explicit `official` install flag selects community
minimization. The flag is configuration, not user consent or an authorization
boundary. A custom DSN changes the recipient, not necessarily the data policy.

| Field in an error event | Community | Official |
| --- | --- | --- |
| User object | Removed | Application user ID retained; other user fields removed |
| Request headers | All removed | Five named sensitive headers removed; other headers can remain |
| Request body/cookies | Removed | Removed |
| Breadcrumbs | Removed | Retained with field/pattern scrubbing; can include console/navigation/click metadata |
| Host/machine name and URL origin | Removed from the fields handled by community minimization | Can remain |
| Device/app/locale contexts | Removed; OS/runtime/browser reduced to name/version, trace context retained | SDK context retained with sensitive-key/text filtering |
| Exception-frame local variables | Removed | Not removed by Mike's scrubber if present; local-variable collection is not enabled by current SDK options |
| In-app source lines | Retained | Retained |

**This table applies to error events, not sessions.** Removing `event.user`
does not remove session `did`, and removing event headers does not remove a
session's `user_agent`.

## Removed data and remaining paths

The error scrubbers remove request bodies and cookies. They remove these
headers by case-insensitive exact name: `authorization`, `cookie`,
`set-cookie`, `x-api-key`, and `x-supabase-auth`. Community mode subsequently
removes all remaining request headers. Raw console arguments and `extra.body`
are replaced with `[Filtered]`.

Pattern filtering covers recognized bearer tokens, JWTs, selected provider
key formats, email addresses, sensitive URL parameter names, and the token
after `/download/`. This is pattern matching, not semantic classification.

The `extra` allowlist includes the following field names (values still pass
through credential-pattern scrubbing):

```text
bookmarkName code dedupe_key detail document_id documentId err error
error_stack exit_code file_id fileId id job_id jobId kind message name path
request_id requestId review_id reviewId row_id rowId session_id sessionId
stableEditId stack stage status statusCode tool tool_call_id
unhandledPromiseRejection url version_id versionId worker_id workerId
```

Names such as `detail`, `message`, and `name` do not restrict values to safe
codes. Tags and SDK contexts use a sensitive-key denylist rather than a
complete allowlist. Source snippets and every top-level event field are not
uniformly scrubbed. Therefore, do not describe this as an enforced guarantee
that no legal text, filename, customer name, or arbitrary secret can be sent.

## Confirmed audit findings

1. **Session identity bypass.** Automatic session health is enabled through
   SDK defaults. Session serialization can retain the authenticated user ID
   despite community error-event minimization. The SDK's scope/session code
   and an offline transport reproduction confirm the mechanism.
2. **URL query content survives.** Both scrubbers retain ordinary query
   values. A `q`, `search`, or other non-credential parameter can contain
   sensitive text. Route normalization in `reportApiFailure` does not clean
   the separately attached raw path or every SDK request URL.
3. **Free text survives.** Synthetic private-clause markers remained in
   error/message text, `extra.detail`, custom tags, and a transaction name.
   This proves what the scrubber permits, not that customer text was observed
   in Sentry. The first console argument is assumed to be a safe static label.
4. **Official headers are only partly filtered.** A synthetic
   `X-Custom-Secret` header survived official-mode scrubbing. The request
   header loop does not apply the broader sensitive-key pattern. Community
   mode removed that header with all other request headers.
5. **Code context is transmitted.** Actual backend traffic contained source
   lines. The synthetic scrubber probe retained an in-app source literal.
   Source-map uploads are an additional source-code disclosure channel.
6. **The local sink is not a complete envelope audit.**
   `scripts/sentry-sink.mjs` parses envelopes but records/displays only items
   with type `event`. Its page omits sessions and client reports. Audit all
   transport envelope items, not just that page or Sentry's issue view.

## What Sentry can know beyond the JSON

The receiving service sees the network source IP of the sender/proxy as part
of accepting the connection. Browser events routed through Mike's tunnel
have a different network path from direct SDK submissions. Removing an IP
field from JSON does not make the connection anonymous. In the earlier live
verification, Sentry displayed geographic enrichment even though the
outbound community error had no user object.

Storage, retention, geographic inference, access controls, and onward
integrations require an account-side audit. `sendDefaultPii: false` alone
does not establish those policies. This audit does not certify account-wide
retention or that no IP-derived information is retained.

Build-time source-map uploads are distinct from runtime reports. When the
three upload settings are present, application artifacts can include original
source via `sourcesContent`; deleting local maps after upload does not delete
the copies in Sentry. The prior upload exercise used Mike's organization and
synthetic code. See [Sentry's source-map documentation](https://docs.sentry.io/platforms/javascript/guides/hono/sourcemaps/troubleshooting_js).

## Recommended acceptance criteria before privacy sign-off

- Explicitly disable unneeded session tracking, or define and enforce a
  separate session schema that excludes user identity and unnecessary
  user-agent/timing data. Cover all runtimes and all envelope item types.
- Strip URL queries/fragments and arbitrary request headers by default;
  retain only intentional route templates and approved diagnostic fields.
- Apply the same minimum privacy protections to official users. Retain
  identifiers only where there is a stated debugging purpose and disclosure.
- Define approved error codes/context and audit exception/console call sites
  for user-provided text. Regex replacement cannot supply this guarantee.
- Decide explicitly whether source snippets and source-map uploads are
  acceptable, especially for private forks. Keep replay/screenshots absent.
- If performance sampling is enabled later, audit transaction/span payloads
  separately: the current error `beforeSend` hook is not a transaction scrubber.
- Validate authenticated browser, Word, server, and worker flows with only
  synthetic data and an in-memory/local transport; fail tests on unexpected
  fields or envelope types, including sessions and attachments.

## Evidence and reproducibility

Reviewed code:

- [Shared event scrubber and community minimization](../frontend/src/shared/lib/sentryEvent.ts)
- [Backend initialization and scrubber](../backend/src/lib/observability/sentry.ts)
- [Web reporting and user scope](../frontend/src/app/lib/errorReporting.ts)
- [Word reporting and user scope](../word-addin/src/taskpane/lib/errorReporting.ts)
- [Frontend source-map upload configuration](../frontend/next.config.ts)

Local-only audit artifacts on the machine running this review:

```text
/private/tmp/pr450-data-audit.cjs
/private/tmp/pr450-session-audit.cjs
/private/tmp/pr450-data-audit/synthetic-probe-results.json
/private/tmp/pr450-data-audit/session-bypass-proof.json
/private/tmp/pr450-data-audit/captured-envelope-items.json
```

The scripts use synthetic markers and no network transport. The captured
envelope items are the earlier synthetic live API/browser proof, not a
customer export. These temporary files are not committed to the repository.

Validation: 41 backend reporting tests and 55 frontend/shared reporting tests
passed; both local audit probes passed their assertions. Existing tests passing
does not resolve the findings above: those tests did not prohibit the newly
identified session and metadata paths.
