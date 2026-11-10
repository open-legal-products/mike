import type { Db } from "./supabase";
import { findDocumentsOutsideWorkspace } from "./documentWorkspace";
import { teamOrgIdsAmong } from "./personalOrgs";
import { isUuid } from "./uuid";
import { catalogKeyFromWorkflowId } from "./workflowCatalog";

type WordAttachments = {
  files?: { document_id?: string | null }[] | null;
  workflow?: { id?: string } | null;
  playbook?: { id?: string } | null;
};

/** Word history, settings and memory are Personal until Word has workspace support. */
export async function wordChatHasWorkspaceAttachments(
  db: Db,
  messages: WordAttachments[],
  chatId?: string | null,
): Promise<boolean> {
  const attachments = [...messages];
  if (chatId) {
    const { data, error } = await db.from("word_chat_messages")
      .select("files, workflow, playbook").eq("chat_id", chatId);
    if (error) throw new Error("Failed to validate Word chat attachments");
    attachments.push(...((data ?? []) as WordAttachments[]));
  }
  const documentIds = [...new Set(attachments.flatMap(message =>
    (message.files ?? []).flatMap(file => file.document_id ? [file.document_id] : []),
  ))];
  if ((await findDocumentsOutsideWorkspace(db, documentIds, null, { includeWorkflowAssets: true })).length) return true;
  const workflowIds = [...new Set(attachments.flatMap(message => {
    const id = message.workflow?.id;
    return id && catalogKeyFromWorkflowId(id) === null ? [id] : [];
  }))];
  const playbookIds = [...new Set(attachments.flatMap(message =>
    message.playbook?.id && isUuid(message.playbook.id) ? [message.playbook.id] : [],
  ))];
  const orgIds: (string | null | undefined)[] = [];
  if (workflowIds.length) {
    const { data, error } = await db.from("workflows").select("id, org_id").in("id", workflowIds);
    if (error) throw new Error("Failed to validate Word workflows");
    orgIds.push(...(data ?? []).map((workflow: { org_id?: string | null }) => workflow.org_id));
  }
  if (playbookIds.length) {
    const { data, error } = await db.from("playbooks").select("id, org_id").in("id", playbookIds);
    if (error) throw new Error("Failed to validate Word playbooks");
    orgIds.push(...(data ?? []).map((playbook: { org_id?: string | null }) => playbook.org_id));
  }
  if (!orgIds.length) return false;
  return (await teamOrgIdsAmong(db, orgIds)).size > 0;
}
