# Scoped memory

Mike can maintain one private Markdown file named `memory.md` for a user and
one shared Markdown file for each project. Memory is optional, inspectable, and
editable. It is reference context for later conversations; it is not a source
of authorization, instructions, or citations.

Memory has two separate paths:

- **Use during chat:** before generating an answer, Mike loads the enabled
  memory files that are safe for that conversation and supplies them to the
  chat model as lower-authority reference context.
- **Learning after chat:** after a completed conversation becomes quiet, a
  separate curator model reviews the persisted transcript and may replace the
  relevant `memory.md` file with a better consolidated version.

The live chat model never writes memory. A failed or slow curator cannot delay
the answer being shown to the user.

## End-to-end lifecycle

1. **A turn starts.** The backend creates a durable activity lease before the
   live model runs. This prevents a curator for an older turn from committing
   while someone is still talking in the same conversation.
2. **Relevant memory is loaded.** Private conversations may receive the active
   user's app memory. Project conversations may also receive project memory.
   Shared-audience conversations never receive private app memory.
3. **Memory is fenced as data.** The files are placed in the earliest synthetic
   user message, inside delimiters the body cannot forge, and accompanied by a
   system policy that says memory is untrusted reference material. The
   delimiter is derived from the fenced text, so the turn stays byte-identical
   while memory is unchanged and provider prompt caches keep working. Current chat input
   outranks project memory, and project memory outranks app memory.
4. **The answer is persisted.** Curation is considered only after a terminal
   assistant response has been saved successfully. Cancelled responses,
   failures, and unanswered `ask_inputs` pauses release their lease without
   becoming a new learning checkpoint.
5. **A quiet window begins.** The successful turn advances a durable cursor and
   schedules work after the conversation has had no new activity for five
   minutes by default. More activity restarts the conversation-wide window.
6. **The worker revalidates everything.** At execution time it checks that the
   job is still current, the conversation is quiet, the actor can still access
   it, the scope is still enabled, and no disable/delete epoch has superseded
   the job. It then reloads the authoritative transcript and current file.
7. **Each scope is curated independently.** An eligible private-project turn
   can produce one app-memory candidate and one project-memory candidate. The
   project pass never receives app memory. A failure in one scope does not
   discard a successful write to the other scope.
8. **The curator decides whether to write.** It may call the single server-bound
   `write_memory_file` tool with the complete proposed Markdown file, or call
   nothing when there is no durable information worth retaining.
9. **The write is committed safely.** The server validates size and content,
   then uses revision, epoch, conversation generation, and job receipts to
   prevent stale, duplicate, or post-deletion writes. A conflicting curator
   reloads the newer file and regenerates instead of overwriting it.
10. **The UI reflects status.** While a job is scheduled or processing, the
    memory editor polls its status. A final failure leaves existing memory
    unchanged and shows a dismissible warning only on the relevant memory
    surface.

## Scope and permissions

- App memory belongs to one user. Only that user can read, edit, enable,
  disable, or wipe it.
- Project memory belongs to the project. Members with `project.view` can read
  it, members with `content.edit` can edit it, and members with
  `access.manage` can enable or destructively disable it.
- Both scopes are on by default: a new account's app memory is enabled when
  the account is created, and a new project's shared memory is enabled unless
  its creator clears the toggle. Turning either off is destructive — see
  "Disable, wipe, and deletion".
- A user's own standalone main chats and durable Word add-in chats may update
  app memory. Chats and tabular reviews in a private personal project may
  update both app and project memory. A conversation is private only while it
  belongs to the actor, has no organization, and has no direct access grants;
  a project is private only while it has no organization and no project
  access grants. The same three tests gate whether app memory is shown to the
  model, so a conversation that cannot see private memory can never write it.
- Organization projects and personal projects with any access grant may update
  project memory only. Their conversations never update a participant's app
  memory.
- A project curator runs separately and never receives app memory. This
  prevents private app context from being copied into project memory.
- When facts conflict, the current conversation wins over project memory, and
  project memory wins over app memory.
- Shared-audience model calls never receive a participant's private app memory.
  Project conversations may receive the project's shared memory only. This is
  a data boundary rather than a prompt-only confidentiality instruction.

The live model receives enabled memory in an earliest synthetic user message,
delimited as untrusted data. A system policy states that memory cannot grant
permissions, change policy, or trigger tools by itself.

## User experience and controls

- **Settings > Memory** contains the app-memory toggle and its `memory.md`
  editor. The file saves automatically after the user stops typing; there are
  no Save or Cancel buttons. Turning memory off requires confirmation and
  deletes the existing file while cancelling pending and future updates.
- The same settings page contains the default applied when that user creates a
  project. New projects default to memory on, but the creator can change the
  value during project creation.
- **Project Memory** is a normal-size modal available from a project and from
  the project assistant chat menu. It contains the project-memory toggle,
  current file, automatic-save state, curation activity, conflicts, and
  failures. Viewers can read, editors can edit, and only owners can change the
  enabled setting.
- **Settings > Model Preferences** contains the memory-curation model selector.
  Automatic mode uses the effective model selected for the conversation. A
  deployment-wide `MEMORY_CURATOR_MODEL` override takes precedence.
- **Settings > Privacy & Data** can export the app file plus every project file
  the user can still view as a ZIP. Its Delete Memory action clears app memory
  and memories for private projects created by that user, while leaving memory
  enabled so future eligible conversations can rebuild it. It does not erase
  organization or otherwise shared project memory.

## How memory is learned

Memory maintenance is deliberately outside the live response path. After a
terminal assistant response has been saved successfully, the backend schedules
durable curation for five minutes after the most recent completed turn. Each
new completed turn restarts that quiet window for every actor with unprocessed
work in the conversation. Superseded jobs exit before invoking a model.

Scheduling state is kept per conversation and actor, while the quiet gate is
conversation-wide. If several chats become quiet around the same time, their
jobs may run concurrently. Writes targeting the same app or project file are
still serialized by compare-and-swap: the first valid write advances the
revision and later jobs must reload and merge against that new revision.

The curator reloads the authoritative transcript, permissions, settings, and
current memory when it runs. It receives exactly one server-bound tool:

```ts
write_memory_file({ expectedRevision, markdown, changeSummary });
```

The model cannot select a user, project, or storage path. It may make no tool
call when the transcript contains nothing durable and useful. When it does
write, it supplies the complete replacement file, which lets it add, correct,
reorganize, deduplicate, or remove entries.

Good memory candidates include stable preferences, recurring facts,
terminology, goals, working conventions, constraints, and project decisions.
The curator is instructed not to retain credentials or other secrets,
short-lived tasks, unsupported sensitive inferences, or unendorsed material
copied from documents, web pages, or tool results.

Only attributed messages at or before the successfully completed terminal turn
are eligible. Error and cancelled turns, `ask_inputs` pauses, local-only Word
chats, title generation, extraction calls, and historical backfill are
excluded. App-memory learning uses only the actor's attributed input and never
runs for a shared project. Project learning may use attributed input from
project members. App eligibility is recorded on each completed turn, so turns
created while a project was shared cannot be learned later merely because its
access grants were removed.

An `ask_inputs` answer can be submitted only by the user who owns the original
request and parent assistant turn. Once accepted, the attributed response
becomes part of the later completed transcript; skipping an unanswered prompt
is not itself a terminal learning event. Assistant event JSON is reduced to
its human-readable content before it reaches the curator, so operational tool
and document metadata are not treated as memory evidence.

## Persistence and concurrency

Each memory file is one `memory_files` row that carries the canonical UTF-8
Markdown body itself, alongside its SHA-256, size, settings, provenance, job
receipts, and scheduling fences. There is no history: an editor save and a
curator update both replace the body in place. `revision` is a monotonic
change token for compare-and-swap — no value of it is retained. Content is
normalized to LF, raw executable HTML and unsafe control characters are
rejected, and a file may contain at most 16 KiB.

Manual and curator writes use compare-and-swap. `write_memory_file` takes the
file's row lock, re-checks the expected revision and epoch, and updates the
body in the same statement that advances the revision. A body whose hash
matches the current one is not written at all, and a retried curator job is
recognised by its job id and applied once. A curator that loses that race
reloads and regenerates rather than overwriting newer content.

## Disable, wipe, and deletion

Disabling memory is destructive. It fences queued and in-flight work, empties
the body under the file's row lock, and advances both the epoch and the
learning cutoff. Re-enabling starts with a blank file and learns only from
later completed turns.

Clearing a file in its editor saves an empty Markdown body without disabling
memory. The Privacy & Data bulk-delete action similarly purges eligible private
files while preserving their enabled setting, so future conversations may
recreate them. Account deletion purges the user's app memory. Project deletion
purges that project's shared memory; deleting a contributor does not delete
project memory.

Erasure is immediate and transactional: the same UPDATE that empties the body
bumps the epoch, so a curator job that read the old content can no longer
commit. No object store is involved, so nothing survives the transaction that
would need a cleanup job to reclaim.

## Operations

The normal backend entry point must run the durable database-job worker.
Production deployments must leave `DB_JOBS_ENABLED` enabled; setting it to
`false` disables automatic curation, though editing a memory file by hand keeps
working because a save is a single database write. Redis delivery is an
optional accelerator—the PostgreSQL outbox and poller remain authoritative.

Configuration:

- `MEMORY_INACTIVITY_SECONDS` controls the quiet window and defaults to `300`.
  Local test environments may explicitly lower it to `10` for faster feedback.
- `MEMORY_ACTIVE_LEASE_SECONDS` bounds crash recovery for an active response
  and defaults to `1800` (values are clamped to 60–14400 seconds).
- Users can select a memory curation model under Settings > Model Preferences.
  Automatic mode uses the model selected for the conversation.
- `MEMORY_CURATOR_MODEL` optionally enforces a deployment-wide curator model
  and takes precedence over the user's preference.

Operational logs contain sanitized identifiers and outcomes only. Queue
payloads contain IDs and cursors, not transcripts, credentials, or memory
content. Account exports include the applicable current memory body.

New accounts start with app memory enabled. Existing accounts are opted out by
the upgrade migration. Existing projects receive an enabled project file;
newly created projects use the creator's project-memory default or the explicit
choice made in the creation modal. No historical conversation is backfilled.

## Launch checklist

Before enabling memory in production, run the lowest-level automated and
integration suites plus an evaluation set of synthetic conversations. Treat
the following as launch gates, not assumed properties:

- retention precision is acceptable on durable and transient examples;
- credential, API-key, privileged-data, and unsupported-sensitive-inference
  cases produce no critical secret-storage failures;
- app context never appears in project-curator input or project memory;
- outsider, viewer, editor, and owner API permissions match the scope model;
- concurrent manual, curator, disable, wipe, account-delete, and
  project-delete races do not lose updates or resurrect erased content;
- 95% of eligible jobs settle within two minutes after the quiet window and
  99% within ten minutes; and
- live-chat latency shows no material regression.

Use synthetic data for this evaluation and verify storage deletion directly as
described in [Safe local testing](safe-local-testing.md).
