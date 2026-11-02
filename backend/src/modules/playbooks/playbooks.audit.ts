// Playbook activity in the audit history (public.audit_events), recorded the
// way chats, documents, and tabular reviews record theirs: one row per user
// action, written through recordAudit, which never throws.
//
// Rows carry names and ids, never playbook content: no rule text, no finding
// text, no reviewed contract text. A review's outcome is its count of
// findings per status.

import { recordAudit, type AuditEventInput } from "../../lib/audit";
import type { Db } from "../../lib/supabase";
import type {
  Playbook,
  PlaybookImportWork,
  PlaybookReviewWork,
} from "./playbooks.operations";

export const PLAYBOOK_AUDIT_SURFACE = "playbooks";

export type PlaybookAuditAction =
  | "playbook.created"
  | "playbook.imported"
  | "playbook.replaced"
  | "playbook.deleted"
  | "playbook.run"
  | "playbook.run.deleted";

export function recordPlaybookAudit(
  db: Db,
  event: Omit<AuditEventInput, "action" | "surface"> & {
    action: PlaybookAuditAction;
  },
): Promise<void> {
  return recordAudit(db, { ...event, surface: PLAYBOOK_AUDIT_SURFACE });
}

/**
 * The playbook's organization and current name, for a row recorded away from
 * the request that loaded the playbook. A playbook deleted meanwhile, or a
 * failed lookup, gives nulls: the row is still worth recording.
 */
async function playbookAuditContext(
  db: Db,
  playbookId: string,
): Promise<{ orgId: string | null; name: string | null }> {
  try {
    const { data } = await db
      .from("playbooks")
      .select("org_id, name")
      .eq("id", playbookId)
      .maybeSingle();
    return {
      orgId: (data?.org_id as string | null | undefined) ?? null,
      name: (data?.name as string | null | undefined) ?? null,
    };
  } catch {
    return { orgId: null, name: null };
  }
}

/** How many findings a review reached per status: its outcome, not its text. */
export function findingOutcomeCounts(
  findings: readonly { status: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { status } of findings) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/**
 * A review that ended. Called only by the claim whose guarded write recorded
 * the outcome, so a re-claimed job does not record one review twice.
 */
export async function recordPlaybookRunAudit(
  db: Db,
  work: PlaybookReviewWork,
  outcome:
    | { status: "completed"; findings: readonly { status: string }[] }
    | { status: "failed" },
): Promise<void> {
  const playbook = await playbookAuditContext(db, work.playbookId);
  await recordPlaybookAudit(db, {
    userId: work.userId,
    userEmail: work.userEmail,
    orgId: playbook.orgId,
    action: "playbook.run",
    status: outcome.status,
    title: work.content?.name || playbook.name,
    documentId: work.documentId,
    model: work.model,
    detail: {
      playbook_id: work.playbookId,
      run_id: work.runId,
      scope: work.reviewScope,
      posture: work.reviewMode,
      ...(outcome.status === "completed"
        ? { outcomes: findingOutcomeCounts(outcome.findings) }
        : {}),
    },
  });
}

/** One of the caller's runs, deleted. */
export async function recordPlaybookRunDeletedAudit(
  db: Db,
  run: {
    userId: string;
    userEmail?: string | null;
    runId: string;
    playbookId: string;
    documentId: string | null;
  },
): Promise<void> {
  const playbook = await playbookAuditContext(db, run.playbookId);
  await recordPlaybookAudit(db, {
    userId: run.userId,
    userEmail: run.userEmail,
    orgId: playbook.orgId,
    action: "playbook.run.deleted",
    title: playbook.name,
    documentId: run.documentId,
    detail: { playbook_id: run.playbookId, run_id: run.runId },
  });
}

/**
 * An import that ended: `playbook.imported` for a new playbook,
 * `playbook.replaced` for a replacement, failed with the stage it stopped at.
 */
export async function recordPlaybookImportAudit(
  db: Db,
  work: PlaybookImportWork,
  outcome: { playbook: Playbook } | { failedStage: string | null },
): Promise<void> {
  const replacing = Boolean(work.replacePlaybookId);
  const playbook = "playbook" in outcome ? outcome.playbook : null;
  await recordPlaybookAudit(db, {
    userId: work.userId,
    userEmail: work.userEmail,
    orgId: playbook?.orgId ?? work.orgId,
    action: replacing ? "playbook.replaced" : "playbook.imported",
    status: playbook ? "completed" : "failed",
    title: playbook?.name ?? work.name ?? work.filename,
    model: work.model,
    detail: {
      import_id: work.attemptId,
      playbook_id: playbook?.id ?? work.replacePlaybookId,
      ...("failedStage" in outcome ? { stage: outcome.failedStage } : {}),
    },
  });
}
