import type { z } from "zod";
import type { EditAnnotation } from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import type { PlaybookRole } from "./playbooks.access";
import type { playbookContentSchema, findingSchema } from "./playbooks.schemas";
export type PlaybookContent = z.infer<typeof playbookContentSchema>;
export type PlaybookFinding = z.infer<typeof findingSchema> & {
  id: string;
  /** The tracked change made in the reviewed document, when one was. */
  edit?: EditAnnotation | null;
};
export type Playbook = {
  id: string;
  userId: string;
  name: string;
  description: string;
  orgId: string | null;
  visibility: "private" | "organization";
  /** The caller's role: viewer (view and run), editor, or owner. */
  role: PlaybookRole;
  isCreator: boolean;
  /** Edit rules, details and sources: editor or owner. */
  canEdit: boolean;
  /** Share, change visibility and delete: owner. */
  canManageAccess: boolean;
  /** Who it is shared with, for its owners only; empty for everyone else. */
  sharedWith: string[];
  /** The creator's profile name and photo; null when they have not set one. */
  creatorName: string | null;
  creatorPhoto: string | null;
  content: PlaybookContent;
  sourceFilename: string | null;
  importModel: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PlaybookImportStage =
  | "validating_file"
  | "checking_model"
  | "extracting_text"
  | "compiling"
  | "validating_output"
  | "repairing_output"
  | "storing_source"
  | "saving_playbook"
  | "completed";
/** An import attempt as the page follows it. */
export type PlaybookImport = {
  id: string;
  status: "running" | "completed" | "failed";
  stage: string;
  error: string | null;
  filename: string;
  name: string | null;
  /** The playbook being replaced, or the one created once completed. */
  playbookId: string | null;
  startedAt: string;
  completedAt: string | null;
};
/** What an import is asked to do, before its file is read. */
export type PlaybookImportRequest = {
  userId: string;
  /** Needed to replace a personal playbook shared with the caller. */
  userEmail?: string | null;
  filename: string;
  /** The file's size in bytes, known before it is read. */
  size: number;
  name?: string;
  workspace?: unknown;
  model: string;
  /** Replace this playbook's content instead of creating a new playbook. */
  playbookId?: string;
  db?: Db;
};
/**
 * Everything compiling an import needs besides the file's bytes: its row's
 * columns, plus two ids the row cannot hold. The replace target is kept
 * apart because the row's playbook_id is set null if that playbook is
 * deleted, and a new playbook's id is chosen up front so a re-run of the
 * same import saves the same playbook instead of a second one.
 */
export type PlaybookImportWork = {
  attemptId: string;
  userId: string;
  userEmail: string | null;
  filename: string;
  name: string | null;
  model: string;
  orgId: string | null;
  replacePlaybookId: string | null;
  /**
   * The replace target's updated_at when the import began. The compiled
   * content is saved only if the playbook still has it, so an edit made in
   * between fails the import instead of being overwritten. Absent only on a
   * job queued before the column existed.
   */
  targetUpdatedAt?: string | null;
  newPlaybookId: string;
  startedAt: string;
};
export type PlaybookReviewRequest = {
  userId: string;
  userEmail?: string | null;
  playbookId: string;
  /** Text extracted by the caller; a stored Word document is read instead. */
  documentText?: string;
  documentName?: string;
  /** A stored document to review; a Word document also gets tracked changes. */
  documentId?: string;
  instructions?: string;
  model: string;
  reviewMode: "strict" | "permissive";
  /** "issues" reports only what needs attention; the run records which. */
  reviewScope?: "full" | "issues";
  db?: Db;
};
/**
 * What a review needs that its run row does not record. The rules, model,
 * mode, scope, and document reference are all on the row; the text reviewed
 * and the document version the edits are made against are fixed here when the
 * review is requested, so a re-run reviews the same text and its edits are
 * refused, not doubled, if an earlier run already revised the document.
 */
export type PlaybookReviewInput = {
  runId: string;
  /** Also what account erasure purges queued jobs by (payload.userId). */
  userId: string;
  documentText: string;
  instructions: string | null;
  userEmail: string | null;
  expectedVersion: { id: string; storagePath: string } | null;
};
/** A review as runPlaybookReview performs it: its row plus its input. */
export type PlaybookReviewWork = PlaybookReviewInput & {
  playbookId: string;
  content: PlaybookContent;
  model: string;
  reviewMode: "strict" | "permissive";
  reviewScope: "full" | "issues";
  documentId: string | null;
  documentName: string | null;
  startedAt: string;
};
