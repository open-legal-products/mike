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
// A workflow's own files are left out: they are reached through the
// workflow, and where a workflow may be used is the workflow's rule.

import { teamOrgIdsAmong } from "./personalOrgs";
import type { Db } from "./supabase";

export const DOCUMENT_WORKSPACE_MISMATCH_CODE = "document_workspace_mismatch";

export const DOCUMENT_WORKSPACE_MISMATCH_DETAIL =
    "One or more of those documents belong to a different workspace. Choose documents from this workspace, or upload them here.";

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
    const workflowOrg = new Map<string, string | null>();
    const workflowIds = [...new Set(documents.flatMap(document => document.workflow_id ? [document.workflow_id] : []))];
    if (workflowIds.length) {
        const { data, error } = await db.from("workflows").select("id, org_id").in("id", workflowIds);
        if (error) throw new Error("Failed to read the documents' workflows");
        for (const row of data ?? []) workflowOrg.set(row.id, row.org_id ?? null);
    }
    const storedOrg = (document: DocumentPlacement) =>
        document.workflow_id ? workflowOrg.get(document.workflow_id) ?? document.org_id ?? null :
        document.project_id
            ? (projectOrg.get(document.project_id) ?? null)
            : (document.org_id ?? null);

    const teamOrgIds = await teamOrgIdsAmong(db, [
        orgId,
        ...documents.map(storedOrg),
    ]);
    const workspaceOf = (stored: string | null | undefined) =>
        stored && teamOrgIds.has(stored) ? stored : null;
    const workspace = workspaceOf(orgId);
    return documents
        .filter((document) => workspaceOf(storedOrg(document)) !== workspace)
        .map((document) => document.id);
}

type MessageWithFiles = {
    files?: { document_id?: string | null }[] | null;
};

function attachedDocumentIds(messages: MessageWithFiles[]): Set<string> {
    const ids = new Set<string>();
    for (const message of messages) {
        for (const file of message.files ?? []) {
            if (typeof file?.document_id === "string" && file.document_id)
                ids.add(file.document_id);
        }
    }
    return ids;
}

/**
 * The documents a chat turn would newly bring in from another workspace.
 *
 * `messages` is what the client sent — the whole conversation, every turn —
 * so every attachment in it is looked at, not just the last message's.
 * Documents already attached to the stored conversation are let through:
 * a chat that drew on another workspace before this rule keeps working.
 */
export async function findNewAttachmentsOutsideWorkspace(
    db: Db,
    params: {
        messages: MessageWithFiles[];
        /** The stored chat, when the turn continues one. */
        chatId: string | null;
        /** The organization the chat belongs to, or null. */
        orgId: string | null | undefined;
    },
): Promise<string[]> {
    const requested = attachedDocumentIds(params.messages);
    if (requested.size === 0) return [];
    if (params.chatId) {
        const { data, error } = await db
            .from("chat_messages")
            .select("files")
            .eq("chat_id", params.chatId)
            .eq("role", "user");
        if (error) throw new Error("Failed to read the chat's attachments");
        for (const id of attachedDocumentIds(
            (data ?? []) as MessageWithFiles[],
        )) {
            requested.delete(id);
        }
        if (requested.size === 0) return [];
    }
    return findDocumentsOutsideWorkspace(db, [...requested], params.orgId);
}
