// Project chat service functions: list a project's assistant chats.

import { checkProjectAccess } from "../../lib/access";
import { type Db, attachChatCreatorLabels } from "./projects.shared";

export async function listProjectChats(
  db: Db,
  args: { projectId: string; userId: string; userEmail?: string },
): Promise<
  | { ok: true; chats: unknown[] }
  | { ok: false; kind: "forbidden" }
  | { ok: false; kind: "db_error"; error: unknown }
> {
  const { projectId, userId, userEmail } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { ok: false, kind: "forbidden" };

  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return { ok: false, kind: "db_error", error };
  const chats = data ?? [];
  await attachChatCreatorLabels(db, chats);
  return { ok: true, chats };
}
