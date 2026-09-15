# Backend architecture

The Express backend in `backend/` is organized as **domain modules over a
shared kernel**. This page is the reference for that layout: what goes where,
the rules that keep the layers honest, and the test that enforces them.

```
backend/src/
├── app.ts                 Express app: middleware, rate limits, mounts one router per module
├── index.ts               HTTP entrypoint
├── workerRuntime.ts       queue workers entrypoint (imports modules through facades)
├── middleware/            request plumbing (auth, trusted origin) — depends on lib/ only
├── modules/<domain>/      one directory per HTTP surface (see "Module anatomy")
├── lib/                   shared kernel: infrastructure + cross-domain primitives
├── workers/, jobs/        queue consumers and scheduled jobs — reach modules via facades
└── __tests__/             cross-cutting suites, incl. architecture.test.ts
```

## Module anatomy

Every directory under `src/modules/` follows the same shape:

| File | Role |
|---|---|
| `<name>.routes.ts` | **HTTP layer.** Parses params/query/body, calls service functions, maps their typed results onto status codes and JSON. Never queries the database. |
| `<name>.service.ts` | **Facade.** The module's public surface: named re-exports of the functions other code may call. Exactly one per module. Small modules put the implementation here directly. |
| `<name>.<topic>.ts` | **Service topic files** (large modules only). Business logic and data access for one topic: `documents.versions.ts`, `user.profile.ts`, `tabular.chats.ts`… Take an explicit `db: Db`, return typed results, never touch `req`/`res`. |
| `<name>.shared.ts` | Types and helpers shared by the module's topic files but not exported through the facade. |
| `__tests__/` | Unit tests for the service functions (fake `db`), colocated with the code. |

Streaming endpoints are the one place HTTP leaks into the module body: SSE
loops (header flush, LLM stream, client-abort handling, assistant-message
persistence) stay in the routes file because stream lifetime *is* an HTTP
concern. Only their pre-stream preparation and post-stream persistence live in
the service. `tabular.generateStream.ts` is the single sanctioned exception
that takes `res` directly, because two routes share its stream; its header
says so.

### The service contract

A service function takes the database handle first (`db: Db`, exported from
`lib/supabase.ts`), then request-derived primitives, and returns a
discriminated union rather than throwing or writing a response:

```ts
export async function renameFolder(
  db: Db,
  args: { userId: string; folderId: string; name: string },
): Promise<ServiceResult<Folder>> {
  if (!args.name.trim()) return failure("validation", "name is required");
  const { data, error } = await db.from("folders").update(/* … */);
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", "Folder not found");
  return ok(data);
}
```

The route maps the failure with `sendServiceFailure(res, result)`, so the
status-code policy (`validation` → 400, `forbidden` → 403, `not_found` → 404,
`conflict` → 409, `unavailable` → 503, `error` → 500 via `sendInternalError`)
lives in one file: `lib/serviceResult.ts`. Modules that predate the contract
carry their own `kind` strings with equivalent mappings in their routes file;
new code uses the shared one.

## The rules

1. **`lib/` never imports from `modules/`.** The kernel does not know which
   domains exist. There are no dependency exceptions.
2. **A module is reached from outside only through its facade.** Another
   module, a worker, a job, `app.ts` — none may import a module's topic files.
   The facade is where a module decides what it exposes.
3. **Inside a module, only `*.routes.ts` may import `express`.** Everything
   else is HTTP-agnostic and testable with a fake `db`.
4. **Route files do not query the database.** Every `db.from(...)` /
   `db.rpc(...)` belongs to a service function with a name and a typed result.
5. **Facades re-export by name.** `export *` hides what a module exposes and
   invites accidental coupling.
6. **`middleware/` depends on `lib/`, not on modules.** Request plumbing must
   not pull a domain into every request.
7. **`src/routes/` does not exist.** A new HTTP surface is a new module.
8. **Document version writes belong to `modules/documents/`.** Creation, activation, replacement, and deletion go through its facade. The architecture test also rejects direct lifecycle RPC calls from other modules.

## Enforcement

`backend/src/__tests__/architecture.test.ts` walks every file under `src/`,
reads its imports, and fails on a violation of any rule above. It runs with the
normal unit suite (`npm test --prefix backend`), so a layering regression fails
CI the same way a broken assertion does. It needs no lint plugin: a directory
walk and an import regex are enough.

Each rule has an explicit allowlist in the test. Adding an entry is a reviewed
decision and needs a comment saying why; the ratchet for rule 4 records the
remaining inline queries per routes file and only ever goes down.

## The shared kernel (`lib/`)

`lib/` holds two kinds of code:

- **Infrastructure:** `supabase`, `storage`, `queue/`, `dbq/` (durable jobs),
  `llm/`, `mcp/`, `httpError`, `serviceResult`, `pagination`, `search`,
  `privateIp`, `origins`, `runtimeConfig`, `courtlistener` (an external API
  client), `convert`, `pdfjs`, `zipExport`, `concurrency`.
- **Cross-domain primitives** that several modules and the job handlers share:
  `access` (project/document authorization), `audit` (audit-row writes),
  `documentTypes`, `documentVersions`, `modelSelection`, `routerModels`,
  `userLookup`, `workflowCatalog*` (used by the chat tools), `sourceDocuments`
  and pure shared utilities. Document-version reads can join across domains;
  mutations have one owner in the documents module.

The assistant engine lives in `modules/chat/engine/`. Other chat surfaces use
named exports from `chat.service.ts`. HTTP framing lives in `lib/assistantSse.ts`;
message reservation and persistence belong to the chat module.

## Background jobs

`jobs/registry.ts` composes domain handlers from module facades and supplies both
handlers and terminal-failure hooks to the queue runner. Importing a module does
not mutate a global handler map. `lib/dbq/` owns delivery, claiming, retries, and
retention; domain job bodies live with documents, tabular, user, audit, and memory.
BullMQ workers are transport adapters to those same domain operations.

Stale-work sweeps live in documents and tabular. `jobs/maintenance.ts` composes
them. Account erasure and export orchestration belong to the user module.

## Shared operations and caller-specific policy

Reuse an existing operation before adding another service implementation. The
following rules have a single implementation:

| Operation | Owner | Caller responsibilities |
|---|---|---|
| Rename a project's or library's active document version | `modules/documents/documents.rename.ts`, exported as `renameDocument` | Supply the actor and explicit project/library scope; adapt the result to the existing endpoint shape. The operation checks project permissions and scopes both document queries. |
| Delete collection documents and durably clean all version artifacts | `modules/documents/documents.cleanup.ts`, exported as `deleteCollectionDocuments` | Project callers authorize `docs.organize` and select document IDs inside that project first. Library callers supply the authenticated user's ID and collection; the operation filters eligible IDs. Deletion repeats the scope predicates; database triggers capture source, PDF, and extracted-text keys in the same transaction. |
| Resolve a chat turn's model and reasoning level | `modules/user/user.chatSelection.ts`, exported as `resolveUserChatSelection` | Authorize the chat first; retain each surface's persistence, error mapping, and stream lifetime. Selection itself does not mutate chats or saved preferences. |
| Validate folder paths and moves; collect a deletion subtree | `lib/folderTree.ts` | Supply a scoped folder list/loader and retain the endpoint's validation order and error messages. |
| Resolve an assignable organization member | `lib/orgAccessOverrides.ts`, `findAssignableOrgMember` | Authorize the actor's access-management permission and validate the requested role before resolving the target. Creators and organization admins retain owner access. |

Shared code must preserve meaningful differences. Library renames still expose
`folder_id` and project renames still conceal denied project access as 404.
Word's local chat mode remains free of chat persistence. Copy callers explicitly
choose their transport and whether a missing rendition is optional or fatal.

### Document lifecycle

- `createDocumentVersion` atomically allocates the version number, inserts the
  row, and activates it. Stable upload IDs are idempotent: a retry neither
  overwrites metadata nor reactivates an older version.
- `createDocumentVersions` commits a copy batch's versions and pointers together.
- `activateDocumentVersion` validates that the version is live and belongs to the
  document. Use deferred activation when dependent edit rows must be saved first.
- `updateDocumentVersion` repeats the document scope and excludes tombstones.
- `deleteVersion` retains its actor checks and uses a transaction that prevents
  deleting the final live version, including concurrent deletes.
- The `document_version_cleanup` trigger records source, PDF, and extracted-text
  cleanup in the deletion/replacement transaction. Cascades use the same rule.
  `document.cleanup` retries without a terminal attempt limit, protects surviving
  storage references, and waits for an in-flight text-cache writer.
- `DB_JOBS_ENABLED=false` uses the same cleanup implementation inline. The trigger
  still retains a durable job if storage fails; normal deployments require no
  application-level path enumeration before deletion.

The lifecycle primitives are trusted persistence operations, not permission
checks. Callers must authorize the destination and separately authorize a copy
source. Project, library, workflow, and upload-session policies remain explicit.

For changes to these rules, add a test of the shared operation and verify the
caller-specific permissions and response contracts. The rename route and
folder-service compatibility suites also pass against the pre-consolidation
PR snapshot (`54d067d3`), so their assertions characterize existing behavior.

## Shared API contracts

`packages/contracts` is the common declaration package for serialized assistant
activity, input requests/responses, source documents, and normalized Word edits.
All three applications resolve `@mike/contracts` to the same authored declarations.
Client event models add their rendering state locally. No client imports a backend
implementation to obtain these types. See [the package guide](../packages/contracts/README.md).

Existing module-local error unions remain supported. New operations use
`ServiceResult<T>`; a feature PR does not need to normalize unrelated endpoints.

## Adding a new domain

1. Create `src/modules/<domain>/` with `<name>.routes.ts` and
   `<name>.service.ts`; split into topic files when the service passes a few
   hundred lines.
2. Mount the router in `app.ts`.
3. Service functions take `db: Db` first and return `ServiceResult<T>` (or a
   module-local union); routes call `sendServiceFailure`.
4. Put unit tests in `src/modules/<domain>/__tests__/`; route-level behavior
   goes in `src/__tests__/integration/`.
5. Run `npm test --prefix backend -- src/__tests__/architecture.test.ts`. If it
   fails, the layering is wrong, not the test.

## Adding a feature within an existing domain

1. Find the operation's owner and call its facade. Add a topic file when the
   behavior is independently understandable; keep public exports named.
2. State the actor and resource scope in the operation's parameters. Check read
   and write permissions independently when a feature copies between scopes.
3. Change a shared wire declaration with its producer and client adapters.
4. Add the smallest useful regression test. Use the database lifecycle SQL tests
   for transaction/cascade behavior; mocks cannot establish transaction safety.
5. Run the architecture test, relevant unit/route tests, builds, and contract
   typecheck. A feature that adds a job also supplies its handler and failure
   hook through its domain facade to the composition root.

For example, a new “copy a library document into a workflow” feature should need
an authorized workflow operation, calls to `copyDocumentVersionFiles` and
`createDocumentVersion`, a route adapter, and tests of scope and response behavior.
It should not add another version counter, pointer update, or cleanup walker.
