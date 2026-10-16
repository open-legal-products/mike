// Documents stay in the workspace they were put in.
//
// A workspace is Personal or one team organization. A document's workspace
// is its project's, or its own when it sits in no project; a chat's or a
// review's is found the same way. Something in one workspace is not built
// from documents in another: an organization's file does not go into a
// personal chat, and a personal file does not go into an organization's.
//
// Being allowed to read a document is a separate question, asked by
// ensureDocAccess. The same person can read documents in several workspaces,
// which is exactly why access alone does not keep them apart.
//
// A workflow's own files are normally left out: they are reached through the
// workflow, and where a workflow may be used is the workflow's rule. A chat
// attachment is the exception (findNewAttachmentsOutsideWorkspace): a file
// attached by id is placed by the workflow it belongs to, and so is a saved
// workflow attached to a message.

import { teamOrgIdsAmong } from "./personalOrgs";
import type { Db } from "./supabase";
import { catalogKeyFromWorkflowId } from "./workflowCatalog";

export const DOCUMENT_WORKSPACE_MISMATCH_CODE = "document_workspace_mismatch";

export const DOCUMENT_WORKSPACE_MISMATCH_DETAIL =
    "One or more of those documents belong to a different workspace. Choose documents from this workspace, or upload them here.";

/** The same refusal for a chat turn, whose attachments include workflows. */
export const CHAT_ATTACHMENT_WORKSPACE_MISMATCH_DETAIL =
    "This chat includes documents or workflows from a different workspace. Choose ones from this workspace, or start a new chat here.";

type DocumentPlacement = {
    id: string;
    project_id: string | null;
    workflow_id?: string | null;
    org_id?: string | null;
};

/**
 * Of `documentIds`, those that live in a different workspace from the one
 * `orgId` names — an organization's id as stored on the chat, review,
 * project or workflow, or null. Ids that name no document are not reported.
 *
 * A read failure throws: answering "none" would wave the documents through.
 */
export async function findDocumentsOutsideWorkspace(
    db: Db,
    documentIds: string[],
    orgId: string | null | undefined,
    options: { includeWorkflowAssets?: boolean } = {},
): Promise<string[]> {
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) return [];
    const { data, error } = await db
        .from("documents")
        .select("id, project_id, workflow_id, org_id")
        .in("id", ids);
    if (error) throw new Error("Failed to read the documents' workspaces");
    const documents = ((data ?? []) as DocumentPlacement[]).filter(
        (document) => options.includeWorkflowAssets || !document.workflow_id,
    );
    if (documents.length === 0) return [];

    // A project document follows its project, whatever its own column says.
    const projectIds = [
        ...new Set(
            documents.flatMap((document) =>
                document.project_id ? [document.project_id] : [],
            ),
        ),
    ];
    const projectOrg = new Map<string, string | null>();
    if (projectIds.length > 0) {
        const { data: projects, error: projectsError } = await db
            .from("projects")
            .select("id, org_id")
            .in("id", projectIds);
        if (projectsError)
            throw new Error("Failed to read the documents' projects");
        for (const project of (projects ?? []) as {
            id: string;
            org_id?: string | null;
        }[]) {
            projectOrg.set(project.id, project.org_id ?? null);
        }
    }
    const workflowOrg = await readWorkflowOrgs(
        db,
        documents.flatMap((document) =>
            document.workflow_id ? [document.workflow_id] : [],
        ),
    );
    const storedOrg = (document: DocumentPlacement) =>
        document.workflow_id
            ? (workflowOrg.get(document.workflow_id) ?? document.org_id ?? null)
            : document.project_id
              ? (projectOrg.get(document.project_id) ?? null)
              : (document.org_id ?? null);

    return idsOutsideWorkspace(
        db,
        orgId,
        documents.map((document) => ({
            id: document.id,
            orgId: storedOrg(document),
        })),
    );
}

/** The organization each named workflow is filed under. */
async function readWorkflowOrgs(
    db: Db,
    workflowIds: string[],
): Promise<Map<string, string | null>> {
    const workflowOrg = new Map<string, string | null>();
    const ids = [...new Set(workflowIds)];
    if (ids.length === 0) return workflowOrg;
    const { data, error } = await db
        .from("workflows")
        .select("id, org_id")
        .in("id", ids);
    if (error) throw new Error("Failed to read the workflows' workspaces");
    for (const row of (data ?? []) as { id: string; org_id?: string | null }[])
        workflowOrg.set(row.id, row.org_id ?? null);
    return workflowOrg;
}

/**
 * Of `placed`, the ids filed in a different workspace from `orgId`'s. A
 * person's own organization and no organization are both Personal.
 */
async function idsOutsideWorkspace(
    db: Db,
    orgId: string | null | undefined,
    placed: { id: string; orgId: string | null }[],
): Promise<string[]> {
    if (placed.length === 0) return [];
    const teamOrgIds = await teamOrgIdsAmong(db, [
        orgId,
        ...placed.map((item) => item.orgId),
    ]);
    const workspaceOf = (stored: string | null | undefined) =>
        stored && teamOrgIds.has(stored) ? stored : null;
    const workspace = workspaceOf(orgId);
    return placed
        .filter((item) => workspaceOf(item.orgId) !== workspace)
        .map((item) => item.id);
}

type MessageAttachments = {
    files?: { document_id?: string | null }[] | null;
    workflow?: { id?: string | null } | null;
};

type AttachmentIds = { documents: Set<string>; workflows: Set<string> };

/** Documents and saved workflows attached to `messages`. Catalog workflows
 *  belong to no workspace and are left out. */
function attachmentIds(messages: MessageAttachments[]): AttachmentIds {
    const ids: AttachmentIds = { documents: new Set(), workflows: new Set() };
    for (const message of messages) {
        for (const file of message.files ?? []) {
            if (typeof file?.document_id === "string" && file.document_id)
                ids.documents.add(file.document_id);
        }
        const workflowId = message.workflow?.id;
        if (
            typeof workflowId === "string" &&
            workflowId &&
            catalogKeyFromWorkflowId(workflowId) === null
        )
            ids.workflows.add(workflowId);
    }
    return ids;
}

/** Where a chat's turns are stored. */
export type StoredChatMessagesTable = "chat_messages" | "word_chat_messages";

/**
 * The attachments — documents and saved workflows — a chat turn would bring
 * in from another workspace. Web, project and Word chats all ask here.
 *
 * `messages` is what the client sent — the whole conversation, every turn —
 * so every attachment in it is looked at, not just the last message's.
 *
 * `storedHistory` decides what happens to what the stored conversation
 * already has attached:
 *
 *   "exempt"   let through, so a chat that drew on another workspace before
 *              this rule keeps working (web and project chats);
 *   "checked"  refused like a new attachment. A Word chat is checked: its
 *              memory and settings follow the chat's workspace, and Word
 *              chats from before they had one may hold another workspace's
 *              files, which the client does not always resend.
 *
 * Returns the offending ids; a read failure throws.
 */
export async function findNewAttachmentsOutsideWorkspace(
    db: Db,
    params: {
        messages: MessageAttachments[];
        /** The stored chat, when the turn continues one. */
        chatId: string | null;
        /** The organization the chat belongs to, or null. */
        orgId: string | null | undefined;
        messagesTable?: StoredChatMessagesTable;
        storedHistory?: "exempt" | "checked";
    },
): Promise<string[]> {
    const requested = attachmentIds(params.messages);
    const checkHistory = params.storedHistory === "checked";
    const isEmpty = () =>
        requested.documents.size === 0 && requested.workflows.size === 0;
    if (params.chatId && (checkHistory || !isEmpty())) {
        const { data, error } = await db
            .from(params.messagesTable ?? "chat_messages")
            .select("files, workflow")
            .eq("chat_id", params.chatId)
            .eq("role", "user");
        if (error) throw new Error("Failed to read the chat's attachments");
        const stored = attachmentIds((data ?? []) as MessageAttachments[]);
        for (const kind of ["documents", "workflows"] as const) {
            for (const id of stored[kind]) {
                if (checkHistory) requested[kind].add(id);
                else requested[kind].delete(id);
            }
        }
    }
    if (isEmpty()) return [];
    const documents = await findDocumentsOutsideWorkspace(
        db,
        [...requested.documents],
        params.orgId,
        { includeWorkflowAssets: true },
    );
    const workflowOrg = await readWorkflowOrgs(db, [...requested.workflows]);
    const workflows = await idsOutsideWorkspace(
        db,
        params.orgId,
        [...workflowOrg].map(([id, orgId]) => ({ id, orgId })),
    );
    return [...documents, ...workflows];
}
