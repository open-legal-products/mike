# Durable job claims

`public.db_jobs` owns durable job state. Redis/BullMQ's `app-jobs` queue
delivers IDs faster; PostgreSQL polling recovers lost deliveries. Both paths
must claim through PostgreSQL and use the same settlement rules.

## Scope and invariants

This work is the claim-correctness foundation for [#277](https://github.com/open-legal-products/mike/issues/277).
It does not complete that issue's OCR reference or add schedules, workflow
definitions, user APIs, or a new production job kind.

The existing registry contains `audit.chat_turn`, `account.delete`,
`storage.cleanup`, `document.cleanup`, `export.build`, `conversion.convert`,
`extraction.extract`, `mcp.refresh_token`, `document.precompute_text`, and
`memory.consolidate`. They retain their existing execution policies. Cleanup
must retain indefinite retries, durable object pointers and independently
fenced coalesced sibling claims.

A claim is identified by row ID, attempt and `claimed_at`; settlement also
requires `status = running`. Never renew `claimed_at`. A nullable separate
`heartbeat_at` can extend the lease only for an explicitly opted-in handler.
Old workers and rows without a heartbeat retain the 600-second stale window.

Settlement has three outcomes: committed (exactly one matching row), lost
ownership (zero rows), or unknown (database/transport failure). Only confirmed
settlement may invoke a terminal-failure hook or arrange retry delivery.
Handler failure and persistence failure are separate outcomes. Neither a
successful HTTP transport nor absence of an exception proves a row changed.

An opted-in handler needs a finite execution deadline, an abort signal and
single-flight, bounded renewals. Expiry must be checked against database time
after acquiring the claim lock, including when no replacement worker exists.
An uncertain renewal stops the controller; it does not release the claim early.
Stopping renewal does not physically terminate arbitrary JavaScript or undo
external effects. Domain writers still need their own idempotency, access,
cancellation and generation fences.

Shutdown stops new claim intake on both delivery paths before awaiting drains.
A claim request already in flight can still commit. If it returns after intake
closed, do not start its handler; recovery occurs through lease expiry. Keep
the standalone worker's existing keepalive and bounded force-exit behavior.

## Acceptance contract

| Case | Required proof |
|---|---|
| Q01 | Current claimant settles success exactly once. |
| Q02 | Reclaimed worker cannot settle, invoke a hook or redeliver. |
| Q03 | Returned/thrown settlement errors do not become handler retries. |
| Q04 | Hooks, retry delivery and deferred attempt refunds require confirmed settlement. |
| Q05 | Renewal preserves claim identity; expired claims cannot renew/settle, including after lock waits. |
| Q06 | Renewal protects a live worker; actual killed-worker work becomes recoverable. |
| Q07 | Old/NULL heartbeat, cleanup exceptions, pending times and claim-by-kind retain semantics. |
| Q08 | Poll and Redis delivery have one database owner; polling covers lost delivery. |
| Q09 | Deadline/uncertainty closes renewal; late bodies cannot settle or leak timers. |
| Q10 | Coalesced siblings settle independently and retain cleanup pointers on failure. |
| Q11 | RPC privileges, index and fresh/upgraded schemas agree. |
| Q12 | Initial timers, in-flight claims, repeated stop/start and force-exit preserve shutdown boundaries. |
| Q13 | Existing domain job and architecture checks remain green. |
| Q14 | New diagnostics exclude payloads, text, credentials and object paths. |

Unit checks establish state-machine behavior. Real PostgreSQL/PostgREST and
separate worker processes must establish locking, permissions, migration and
crash recovery; a skipped stack suite does not establish those properties.

## Operational boundaries

The production opt-in policy map remains empty in this first increment.
Apply the additive migration before updated workers. Retain the added schema
on a code rollback. Do not disable the entire queue to stop one future feature:
`DB_JOBS_ENABLED=false` also disables cleanup and other existing durable work.
Use `WORKERS_MODE=none` on the API when running the existing standalone worker.

Before adding OCR, upgrade every queue consumer, including embedded worker
threads. Old consumers may terminally fail an unfamiliar kind. Disable new
producers and drain/cancel their queued work before rolling back consumer code.

Failure hooks remain best effort: a crash after terminal settlement can omit a
hook, and SQL's abandoned-attempt sweep does not execute JavaScript hooks.
Future OCR state must reconcile terminal queue rows, not rely only on hooks.

## Execution API

`DB_JOB_EXECUTION_POLICIES` in `backend/src/jobs/registry.ts` is empty.
A future adopter supplies `heartbeatIntervalMs` (positive, at most 200,000)
plus `maxDurationMs` (positive, finite, at most 2,147,483,647). The upper
bound follows Node's timer range. Cleanup kinds cannot adopt this controller.
Polling and Redis delivery pass the same registry into `processClaimedJob`.

An adopted handler receives an optional third `DbJobExecutionContext` argument:
immutable `claim`, `signal`, advisory wall-clock `deadlineAt`, monotonic
`remainingMs()`, and `assertOwnership()`. Initial ownership is checked before
the body. Scheduled renewal and ownership assertions share one in-flight
request, capped at ten seconds. Local deadline, shutdown, lost ownership or
an uncertain renewal aborts the signal and stops renewal permanently. Late
body completion cannot settle the queue row. Code must still terminate and
await its own child processes and fence its external/domain effects.

Legacy settlement uses the existing four predicates and checks the returned
ID/error. Adopted settlement uses `settle_live_db_job`, which checks the same
identity and an unexpired lease in one locked database operation. No ambiguous
settlement write is automatically retried. `heartbeat_db_job` and
`settle_live_db_job` are invoker functions with empty search paths and
service-role-only execution privileges.

## Apply and roll back

1. Back up and inspect the target using the normal deployment procedure.
   Apply `20261013_01_db_job_claim_liveness.sql` through
   `DATABASE_URL=... bash backend/scripts/migrate.sh up` before deploying code.
   The migration is additive and has no heartbeat backfill.
2. Budget a write-blocking maintenance window: `ALTER TABLE` takes an
   AccessExclusive lock and the nonconcurrent partial-index build takes a
   Share lock. On 10,000 fictional rows in the disposable verification VM,
   index creation took 2.261 ms; this is **not** a production estimate.
3. Deploy all queue consumers through their existing inline, thread or
   standalone topology. Verify claim/settlement errors, pending/running jobs,
   and cleanup progress. Existing handlers remain non-renewing.
4. For code rollback, restore the previous application version and retain the
   additive column, index and functions. Never delete queued rows or remove
   schema objects to roll back this code. The previous version also restores
   the unchecked-settlement bug; a rollback is not an equivalent fix.
5. Before enabling an OCR policy later, verify every consumer understands its
   kind and implement atomic domain generation/access/cancellation checks,
   bounded provider subprocesses, evidence persistence, and terminal-state
   reconciliation. Suggested 30-second heartbeats/20-minute duration are an
   adoption proposal, not a production policy enabled here.

## Verification recorded on 13 October 2026

Baseline: `0d27c930eb295eee08da259a63885826f5999e09`. Four new settlement
regressions failed against the original runner before the fix. Parallel review
also found and verified fixes for a synchronous-RPC unhandled rejection,
unsafe pause diagnostics and early restart after a failed drain.

| Check | Executed result |
|---|---|
| `npm test --prefix backend` | 238 files passed; 3,398 tests passed. Eight stack files / 74 tests skipped here, then executed separately below. |
| `npm run test:stack --prefix backend` with disposable Supabase and Redis | Eight files / 74 tests passed, zero skips: includes 20 queue SQL tests and 10 real worker-process tests. |
| `npm run build --prefix backend` | Passed. |
| `npm run typecheck:test --prefix backend` | Passed. |
| `npm run typecheck:contracts --prefix backend` | Passed. |
| Fresh schema versus pinned-main upgrade | Full schema fingerprints identical; 113 migrations recorded, zero pending. |
| Historical schema-drift baseline upgrade (`9a1277ba99cbd7dfae77e5b882e5cef8521fca2f`) | Actual migration runner upgrade matches fresh schema. |
| Reapply new migration | Identical schema fingerprint. |
| `git diff --check` | Passed. |

Environment: Node 24.21.0, Supabase CLI 2.108.0, PostgreSQL 17.6.1.139,
PostgREST 14.13 and Redis 7. Backend HTTP/lifecycle tests required local port
binding permission; the restricted-sandbox attempt was superseded by a passing
full run. No real documents or provider credentials were used.

For local reproduction, start disposable services following
[Safe local testing](safe-local-testing.md), set `DB_JOB_TEST_REDIS_URL` to
the disposable Redis, and run the commands above. The stack helper reads local
Supabase credentials; do not commit them. CI supplies Redis explicitly.
Stack files run serially because batch claims share one global queue.

Worker tests use real child processes, PostgREST, PostgreSQL and BullMQ. They
prove renewal of an original claim timestamp older than 600 seconds, immutable
attempt identity, SIGKILL followed by recovery, stale success/failure/retry
suppression, actual Redis/poll competition and renewal, lost-delivery recovery,
and late committed claim responses after stop. Tests deliberately age database
timestamps to exercise the production expiry predicate without waiting ten
minutes. They are not a ten-minute wall-clock soak or an OCR-provider test.
Lock-wait tests independently cross actual lease expiry for both new RPCs.

The test-only additions extend the original file plan with separate lifecycle
and worker-process suites; three existing domain fixtures explicitly add the
new nullable heartbeat field. Production behavior remains within PR1 scope.
No scheduler, graph engine, OCR producer, new dependency or UI is included.
