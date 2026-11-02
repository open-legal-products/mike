/** Names a playbook to attach to a new assistant chat's composer. */
export const LINKED_PLAYBOOK_PARAM = "playbook";

/** A new assistant chat with the playbook attached, ready for documents. */
export function assistantPathWithPlaybook(playbookId: string) {
  return `/assistant?${LINKED_PLAYBOOK_PARAM}=${encodeURIComponent(playbookId)}`;
}
