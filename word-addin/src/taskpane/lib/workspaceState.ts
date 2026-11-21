/**
 * Which workspace the task pane works in, as rules with no React in them.
 *
 * The rules for remembering a workspace, falling back when an organization is
 * gone and switching to one just joined are the web app's (`@mike/client`'s
 * workspaceSelection). What is here is only what the pane adds: where the
 * choice is kept, the server's refusal for a workspace the caller has left,
 * and the words the pane uses.
 * Office-free, so the web app's Vitest can exercise it.
 */
import {
  PERSONAL_WORKSPACE,
  workspaceName,
  type WorkspaceOrg,
  type WorkspaceStorage,
} from "@mike/client";
import { paneStorage } from "./paneStorage";
import type { WordChatStorageMode } from "./wordChatTypes";

/** A list was narrowed to an organization the caller no longer belongs to. */
export const WORKSPACE_NOT_FOUND_CODE = "workspace_not_found";

/**
 * The pane remembers its workspace where it keeps its other preferences:
 * `OfficeRuntime.storage` inside Office, `localStorage` outside it. Both
 * answer asynchronously here, so the pane waits for the answer before it
 * lists anything (`useWorkspaceSelection`'s `ready`).
 */
export const paneWorkspaceStorage: WorkspaceStorage = {
  getItem: (key) => paneStorage.getItem(key),
  setItem: (key, value) => paneStorage.setItem(key, value),
};

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : null;
}

/** The server's 404 for a workspace the caller has left. */
export function isWorkspaceGoneError(error: unknown): boolean {
  return (
    errorStatus(error) === 404 && errorCode(error) === WORKSPACE_NOT_FOUND_CODE
  );
}

/** The organization's name, or a stand-in while the list is loading. */
function organizationLabel(
  workspaceId: string,
  organizations: readonly WorkspaceOrg[] | null,
): string {
  return workspaceName(workspaceId, organizations) || "this organization";
}

/**
 * Why the pane has no chats to offer in this workspace, when that is not
 * simply an empty history: an organization's chats are saved to the account,
 * so with chats kept on this device there is none to show, and a new one
 * cannot start. `null` when chats work as usual.
 */
export function workspaceStorageNotice(
  storageMode: WordChatStorageMode,
  workspaceId: string,
  organizations: readonly WorkspaceOrg[] | null,
): string | null {
  if (storageMode !== "local" || workspaceId === PERSONAL_WORKSPACE) {
    return null;
  }
  return (
    `Chats in ${organizationLabel(workspaceId, organizations)} are saved to ` +
    "your account. Turn on cloud chat history in Settings to chat here."
  );
}

/** The history's empty line for this workspace. */
export function historyEmptyLabel(
  search: string,
  workspaceId: string,
  organizations: readonly WorkspaceOrg[] | null,
): string {
  if (search) return "No matches found";
  if (workspaceId === PERSONAL_WORKSPACE) {
    return "No chats saved for this document";
  }
  return `No chats in ${organizationLabel(workspaceId, organizations)} for this document`;
}

/** The notice shown after the pane fell back from an organization left. */
export function workspaceGoneMessage(name: string | null | undefined): string {
  return `You're no longer a member of ${name || "that organization"}. Showing your Personal workspace.`;
}

const WORKSPACE_GONE_EVENT = "mike:workspace-not-found";

/**
 * Says that a request was refused with `workspace_not_found`. Whichever list
 * found out, the pane's workspace provider re-reads the caller's
 * organizations, and the shared rules then fall back to Personal.
 */
export function announceWorkspaceGone(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WORKSPACE_GONE_EVENT));
}

export function onWorkspaceGone(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(WORKSPACE_GONE_EVENT, listener);
  return () => window.removeEventListener(WORKSPACE_GONE_EVENT, listener);
}
