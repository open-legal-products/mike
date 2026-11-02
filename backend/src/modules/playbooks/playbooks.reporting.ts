// Playbook failures reported to Sentry.
//
// A review or import runs as a background job, so a crash there reaches no
// HTTP error boundary: the row says "failed" and nobody hears of it unless it
// is reported here. Every value below passes the outbound privacy boundary
// (lib/observability/sentryPrivacy.ts), which keeps only allowlisted tag
// values and UUIDs under named id keys; component, stages, job kinds, and
// the three id keys are on that allowlist. Never pass playbook names, rule
// text, file names, or emails: the boundary would drop them, but they must
// not be offered in the first place.

import { AppError } from "../../lib/appError";
import { asReportableError } from "../../lib/httpError";
import {
  reportError,
  type ReportLevel,
} from "../../lib/observability/sentry";
import { safeError } from "../../lib/safeError";
import { deleteFile } from "../../lib/storage";
import type { PlaybookImportStage } from "./playbooks.operations";

export type PlaybookJobKind = "playbook.review" | "playbook.import";

export type PlaybookReportStage =
  | "import.read"
  | "import.check"
  | "import.extract"
  | "import.compile"
  | "import.validate"
  | "import.store"
  | "import.save"
  | "import.record"
  | "import.cleanup"
  | "review.model"
  | "review.apply_edits"
  | "review.save"
  | "review.record"
  | "heartbeat"
  | "job.terminal";

/** The reported stage of an import that failed at `stage`. */
export function importReportStage(
  stage: PlaybookImportStage,
): PlaybookReportStage {
  switch (stage) {
    case "validating_file":
      return "import.read";
    case "checking_model":
      return "import.check";
    case "extracting_text":
      return "import.extract";
    case "compiling":
    case "repairing_output":
      return "import.compile";
    case "validating_output":
      return "import.validate";
    case "storing_source":
      return "import.store";
    case "saving_playbook":
    case "completed":
      return "import.save";
  }
}

/**
 * Failures that are the model's or the provider's, not ours: a timeout, an
 * answer that would not validate, a provider error. Still worth an issue, at
 * warning level, so a model that regresses shows up without paging anyone.
 */
const WARNING_ERROR_NAMES = new Set([
  "TimeoutError",
  "ZodError",
  "PlaybookModelOutputError",
  "AI_APICallError",
  "AI_RetryError",
]);

function defaultLevel(error: unknown): ReportLevel {
  const name = error instanceof Error ? error.name : "";
  return WARNING_ERROR_NAMES.has(name) ? "warning" : "error";
}

/**
 * Report one playbook failure, tagged with its stage: the outbound privacy
 * filter (lib/observability/sentryPrivacy.ts) groups by code location split
 * by component and stage, so a broken stage is one issue. Log it afterwards with console.warn and safeError(): console.error
 * would reach Sentry a second time through the console bridge (which only
 * recognises the reported object itself), and safeError keeps provider and
 * database text out of the server log.
 */
export function reportPlaybookFailure(
  error: unknown,
  context: {
    stage: PlaybookReportStage;
    jobKind: PlaybookJobKind;
    fileType?: "docx" | "pdf" | null;
    level?: ReportLevel;
    ids: { run_id?: string; import_id?: string; playbook_id?: string | null };
  },
): void {
  const reportable = asReportableError(error, reportPlaybookFailure);
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(context.ids))
    if (typeof value === "string" && value) extra[key] = value;
  reportError(reportable, {
    level: context.level ?? defaultLevel(reportable),
    tags: {
      component: "playbooks",
      stage: context.stage,
      job_kind: context.jobKind,
      file_type: context.fileType ?? undefined,
    },
    extra,
  });
}

/**
 * Remove stored objects nothing refers to any more: an upload whose row was
 * never written, the source a saved import replaced, the files of a deleted
 * playbook. Losing one must not fail the caller, but `.catch(() => {})` lost
 * it entirely. Every key is attempted; at most one warning is reported, under
 * its own kind, with the storage adapter's error as the cause (its code
 * reaches Sentry as failure_code). Keys never go on the event: they embed
 * the user's original filename.
 */
export async function removePlaybookObjects(
  keys: ReadonlyArray<string | null | undefined>,
  context: {
    stage?: "import.cleanup";
    ids?: { import_id?: string; playbook_id?: string | null };
  } = {},
): Promise<void> {
  const targets = keys.filter((key): key is string => !!key);
  if (targets.length === 0) return;
  const results = await Promise.allSettled(
    targets.map((key) => deleteFile(key)),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (!failed) return;
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(context.ids ?? {}))
    if (typeof value === "string" && value) extra[key] = value;
  const failure = new AppError(
    "playbooks.cleanup_failed",
    "Playbook object cleanup failed",
    { cause: failed.reason },
  );
  reportError(failure, {
    level: "warning",
    tags: { component: "playbooks", stage: context.stage },
    extra,
  });
  console.warn("[playbooks] object cleanup failed", {
    stage: context.stage,
    error: safeError(failed.reason),
  });
}
