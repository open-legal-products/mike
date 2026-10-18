import type {
    AssistantEvent,
    ConnectorApprovalItem,
    DelegationEffort,
    DelegationEvent,
    DelegationModelTier,
    McpToolEvent,
} from "@mike/contracts";
import { filterAccessibleDocumentIds } from "../../../../lib/access";
import type { NormalizedToolCall } from "../../../../lib/llm";
import { safeError } from "../../../../lib/safeError";
import type { Db } from "../../../../lib/supabase";
import { loadAssistantMessage } from "../contextBuilders";
import { resolveDocLabel, type DocIndex, type DocStore } from "../types";

type DocumentRef = { document_id: string; version_id: string | null };

export type SubagentRecord = {
    tool: string;
    input: string;
    result: string;
    /** The documents the result came from; a document tool without any is not replayed later. */
    documents: DocumentRef[];
};

/**
 * What a subagent did, kept so it can be continued without redoing its work.
 * Provider-neutral text: a continuation may run on another model.
 */
export type SubagentTranscript = {
    v: 1;
    title: string;
    task: string;
    text: string;
    question?: string;
    /** Connector actions it paused on, which its answer asked the user to approve. */
    approval_ids?: string[];
    /** The documents a scoped run could use, by document id: labels change between turns. */
    documents?: string[];
    effort: DelegationEffort;
    tier: DelegationModelTier;
    /** Kept by a continuation. */
    model?: string;
    records: SubagentRecord[];
    omitted: number;
};

export type ResumedTranscript = SubagentTranscript & {
    /** What became of each action it paused on, from its answer's saved events. */
    approvalOutcomes?: string[];
};

const TABLE = "chat_subagent_runs";
const MAX_INPUT_CHARS = 2_000;
const MAX_RECORDS_BYTES = 80_000;
/** Tools whose records came from documents, so a continuation rechecks access. */
const DOCUMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
    "read_document",
    "find_in_document",
    "find_documents",
    "list_documents",
    "fetch_documents",
    "edit_document",
    "replicate_document",
    "run_playbook",
]);
export const REMOVED_RESULT = "[earlier result removed: document no longer available]";

export const actionLabel = (item: ConnectorApprovalItem) =>
    `${item.title} on ${item.connector_name}`;

export function toolRecord(
    call: NormalizedToolCall,
    result: string,
    docStore: DocStore,
    docIndex: DocIndex,
): SubagentRecord {
    // A project-wide search reads documents its input does not name.
    const named =
        call.name === "find_documents" && call.input.scope !== "document"
            ? []
            : [call.input.doc_id, ...(Array.isArray(call.input.doc_ids) ? call.input.doc_ids : [])];
    const documents = named
        .filter((id) => id !== undefined)
        .map((id) => {
            const label = typeof id === "string" ? resolveDocLabel(id, docStore, docIndex) : null;
            const doc = label ? docIndex[label] : undefined;
            return doc && { document_id: doc.document_id, version_id: doc.version_id ?? null };
        });
    return {
        tool: call.name,
        input: JSON.stringify(call.input).slice(0, MAX_INPUT_CHARS),
        result,
        // Without every document it read, a later turn could not recheck access.
        documents: documents.every((doc): doc is DocumentRef => doc !== undefined) ? documents : [],
    };
}

/** The newest records that fit, counting the rest as omitted. */
export function keepNewest(
    records: SubagentRecord[],
    omitted: number,
): Pick<SubagentTranscript, "records" | "omitted"> {
    let size = 0;
    let first = records.length;
    while (first > 0) {
        size += Buffer.byteLength(JSON.stringify(records[first - 1]));
        if (size > MAX_RECORDS_BYTES) break;
        first -= 1;
    }
    return { records: records.slice(first), omitted: omitted + first };
}

async function withoutUnavailableDocuments(
    transcript: SubagentTranscript,
    access: { db: Db; userId: string; userEmail?: string | null },
): Promise<SubagentTranscript> {
    const refs = transcript.records.flatMap((record) => record.documents);
    const accessible = new Set(
        await filterAccessibleDocumentIds(
            [...new Set(refs.map((ref) => ref.document_id))],
            access.userId,
            access.userEmail,
            access.db,
        ),
    );
    const versionIds = [
        ...new Set(refs.flatMap((ref) => (ref.version_id ? [ref.version_id] : []))),
    ];
    const { data: versions } = versionIds.length
        ? await access.db.from("document_versions").select("id").in("id", versionIds)
        : { data: [] };
    const existingVersions = new Set(
        ((versions ?? []) as { id: string }[]).map((version) => version.id),
    );
    const available = (ref: DocumentRef) =>
        accessible.has(ref.document_id) &&
        (ref.version_id === null || existingVersions.has(ref.version_id));
    return {
        ...transcript,
        records: transcript.records.flatMap((record) => {
            if (!DOCUMENT_TOOL_NAMES.has(record.tool)) return [record];
            if (!record.documents.length) return [];
            return [
                record.documents.every(available)
                    ? record
                    : { ...record, result: REMOVED_RESULT, documents: [] },
            ];
        }),
    };
}

export type SubagentRunStore = {
    save(
        delegationId: string,
        status: DelegationEvent["status"],
        transcript: SubagentTranscript,
    ): Promise<void>;
    load(delegationId: string): Promise<ResumedTranscript | null>;
};

/**
 * What became of each approval from the answer's own saved events, so the
 * continued subagent never has to take the delegating assistant's word for it.
 */
function approvalOutcomes(content: unknown, approvalIds: string[]): string[] {
    const events = (Array.isArray(content) ? content : []) as AssistantEvent[];
    const items = new Map<string, ConnectorApprovalItem>();
    const rejected = new Set<string>();
    const ran = new Map<string, McpToolEvent>();
    for (const event of events) {
        if (event.type === "ask_inputs") {
            for (const item of event.items) {
                if (item.kind === "approval") items.set(item.id, item);
            }
        } else if (event.type === "ask_inputs_response") {
            for (const response of event.responses) {
                if (response.kind === "approval" && response.decision === "reject") {
                    rejected.add(response.id);
                }
            }
        } else if (event.type === "mcp_tool_call" && event.approval_id) {
            ran.set(event.approval_id, event);
        }
    }
    return approvalIds.map((id) => {
        const item = items.get(id);
        const action = item ? actionLabel(item) : "An action";
        const outcome = ran.get(id);
        if (outcome?.status === "error") return `${action}: approved, but it failed.`;
        if (outcome) return `${action}: approved and ran. Result: ${outcome.result || "none"}`;
        if (rejected.has(id)) return `${action}: rejected by the user, so it did not run.`;
        return `${action}: no recorded outcome. Do not retry it; tell the delegating assistant.`;
    });
}

export async function purgeExpiredSubagentRuns(db: Db): Promise<void> {
    const { error } = await db
        .from(TABLE)
        .delete()
        .lt("expires_at", new Date().toISOString());
    if (error) throw error;
}

/**
 * Subagent runs kept for 30 days, for their own user in their own chat only:
 * a shared chat's other members never continue someone else's subagent.
 * Saves wait for `flush`, since a run's row needs its answer's message row.
 */
export function createSubagentRunStore(scope: {
    db: Db;
    userId: string;
    userEmail?: string | null;
    chatId: string;
    messageId: string;
}): SubagentRunStore & { flush(): Promise<void> } {
    const { db, userId, chatId, messageId } = scope;
    const pending: Record<string, unknown>[] = [];
    return {
        async save(delegationId, status, transcript) {
            pending.push({
                chat_id: chatId,
                message_id: messageId,
                delegation_id: delegationId,
                user_id: userId,
                status,
                transcript,
            });
        },
        async flush() {
            const rows = pending.splice(0);
            if (!rows.length) return;
            try {
                const { error } = await db.from(TABLE).insert(rows);
                if (error) throw error;
            } catch (error) {
                console.error("[subagents] run save failed", safeError(error));
            }
        },
        async load(delegationId) {
            try {
                const { data, error } = await db
                    .from(TABLE)
                    .select("transcript, message_id")
                    .eq("chat_id", chatId)
                    .eq("user_id", userId)
                    .eq("delegation_id", delegationId)
                    .gt("expires_at", new Date().toISOString())
                    .maybeSingle();
                if (error) throw error;
                const row = data as {
                    transcript?: SubagentTranscript;
                    message_id?: string;
                } | null;
                const transcript = row?.transcript;
                if (transcript?.v !== 1) return null;
                const resumed: ResumedTranscript = await withoutUnavailableDocuments(
                    transcript,
                    scope,
                );
                if (transcript.approval_ids?.length && row?.message_id) {
                    const message = await loadAssistantMessage(db, chatId, row.message_id);
                    resumed.approvalOutcomes = approvalOutcomes(
                        message?.content,
                        transcript.approval_ids,
                    );
                }
                return resumed;
            } catch (error) {
                console.error("[subagents] run load failed", safeError(error));
                return null;
            }
        },
    };
}
