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
   domains exist. (One documented edge remains — see "Known debt".)
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
  and `chat/` (the assistant engine: prompts, tools, streaming, citations).

The second group is domain-flavored. It stays in `lib/` for one concrete
reason: `lib/dbq/handlers.ts` (the durable-job handler registry) and
`lib/chat/` (the assistant engine, which the chat, project-chat, word-chat and
tabular modules all drive) import it, and rule 1 forbids `lib/` from importing
modules. Moving these files into modules would require first moving the job
handlers and the chat engine into modules too. Both are named follow-ups
below; until then the boundary is: *a `lib/` file may move into a module only
when nothing that stays in `lib/` imports it.*

## Known debt and follow-ups

- **`lib/maintenance/staleWork.ts` → `modules/tabular`** is the one `lib →
  modules` edge, allowlisted in the fitness test. The sweep's tabular half
  should move into the tabular module and register itself with the sweeper.
- **Job handlers live in `lib/dbq/handlers.ts`.** A cleaner shape is a
  registry where each module registers its own handlers (`user.jobs.ts`,
  `documents.jobs.ts`…), which would also let `userDataCleanup`,
  `userDataExport`, `auditExport` and friends move into their modules.
- **`lib/chat/` is the chat domain's engine.** It belongs in `modules/chat/`
  behind the facade once the tabular and word-chat consumers import it that
  way. It is left in place because several open PRs edit it heavily.
- **Result shapes.** Modules created before `lib/serviceResult.ts` use their
  own `kind` strings. Migrating them is mechanical and should happen module by
  module, not in one sweep.

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
