// auditJobs — implementation behind the module facade.
// Handlers for the DB queue. Every handler runs with at-least-once
// semantics: it must be idempotent, and it signals "retry me" by throwing.
//
// Registered kinds:
//   audit.chat_turn  — fan out one chat turn's audit rows (durable audit)
//   account.delete   — full account data erasure (survives restarts)
//   storage.cleanup  — delete storage objects/prefixes (no more swallowed
//                      fire-and-forget deletes leaking files)
//   export.build     — build a user data export and park it in storage
//   mcp.refresh_token        — renew an MCP OAuth access token before it
//                      expires, instead of on the request that needs it
//   document.precompute_text — extract a legacy Office file's text once, so
//                      read_document stops paying for LibreOffice per call
//   memory.consolidate — curate scoped Markdown after chat inactivity
import { chatTurnAuditEvents, insertAuditEvent, type ChatTurnAuditBase } from "../../lib/audit";
import { type Db, type DbJob } from "../../lib/dbq/types";

export async function handleChatTurnAudit(db: Db, job: DbJob): Promise<void> {
    const base = job.payload.base as ChatTurnAuditBase | undefined;
    if (!base?.userId) return; // malformed payload — nothing to retry into
    const events = (job.payload.events as unknown[] | undefined) ?? [];
    // Throwing inserts: a transient DB error retries the job. A retry after
    // a partial fan-out can duplicate a row (at-least-once) — for an audit
    // trail a rare duplicate beats a silent gap.
    for (const event of chatTurnAuditEvents(base, events)) {
        await insertAuditEvent(db, event);
    }
}
