import type { Db, DbJob } from "../../lib/dbq/types";

/** The preview insert schedules this durable job atomically. Confirmed
 * previews retain only selected source metadata, without body excerpts. */
export async function handleProjectEmailCleanup(db: Db, job: Pick<DbJob, "payload">) {
  const id = job.payload?.previewId;
  if (typeof id !== "string") return;
  const { error } = await db.from("project_email_previews").delete().eq("id", id).is("confirmed_at", null).lte("expires_at", new Date().toISOString());
  if (error) throw error;
}
