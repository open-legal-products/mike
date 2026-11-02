// Project chat service functions: list a project's assistant chats.

import { checkProjectAccess } from "../../lib/access";
import { type ProjectRole } from "../../lib/permissions";
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
        .order("updated_at", { ascending: false });
  if (error) return { ok: false, kind: "db_error", error };
  const chats = data ?? [];
  await attachChatCreatorLabels(db, chats);
  // Label each row with the caller's role for THAT chat, the way the detail
  // route and the overview RPC already do. Without it the client has nothing
  // to gate on but `user_id === me`, which this PR's model makes wrong in
  // both directions: a project Owner may delete a colleague's chat, and an
  // Editor may not delete one they merely reach through the project.
  //
  // Project-owned chats inherit the project verdict exactly. Their creator
  // and any stale chat-level grant cannot raise or lower that role.
  for (const chat of chats as {
    id: string;
    user_id?: string | null;
    is_owner?: boolean;
    access_role?: ProjectRole | null;
  }[]) {
    chat.is_owner = !!chat.user_id && chat.user_id === userId;
    chat.access_role = access.projectRole;
  }
  return { ok: true, chats };
}
