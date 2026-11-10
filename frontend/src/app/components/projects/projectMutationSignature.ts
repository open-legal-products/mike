import type { Message } from "../shared/types";
import { withDelegationEvents } from "../assistant/message/eventUtils";

/** Completed message event lists are immutable and need scanning only once. */
export function createProjectMutationSignature() {
    const cache = new WeakMap<Message, string[]>();
    let previous: string[][] = [];
    let signature = "";
    return (messages: Message[]) => {
        const parts = messages.map(message => {
            let part = cache.get(message);
            if (part) return part;
            part = [];
            for (const event of withDelegationEvents(message.events ?? [])) {
                if ("isStreaming" in event && event.isStreaming) continue;
                if (event.type === "doc_created" && event.document_id) part.push(`created:${event.document_id}:${event.version_id ?? ""}:${event.filename}`);
                else if (event.type === "doc_replicated") for (const copy of event.copies ?? []) part.push(`replicated:${copy.document_id}:${copy.version_id}:${copy.new_filename}`);
                else if (event.type === "doc_edited") part.push(`edited:${event.document_id}:${event.version_id ?? ""}:${event.version_number ?? ""}`);
            }
            cache.set(message, part);
            return part;
        });
        if (parts.length === previous.length && parts.every((part, index) => part === previous[index] || (part.length === previous[index].length && part.every((value, i) => value === previous[index][i])))) return signature;
        previous = parts;
        signature = [...new Set(parts.flat())].sort().join("|");
        return signature;
    };
}
