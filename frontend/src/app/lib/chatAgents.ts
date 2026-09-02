/**
 * Client-side rules for highlight-assigned agents.
 *
 * Everything here is pure: how a card is labelled, how a proposal is applied
 * to a response, and how the "this part has changed" case is detected. The
 * hook and the components that use it stay free of decisions worth testing on
 * their own.
 */

import type { AssistantEvent, ChatAgent, Message } from "@/app/components/shared/types";

/**
 * How many agents one response may carry. Mirrors the server's cap; the client
 * enforces it too so the "Assign" affordance disappears instead of producing a
 * request that is known in advance to fail.
 */
export const MAX_ACTIVE_CHAT_AGENTS = 6;

/** Longest instruction the assign panel will submit. Mirrors the server cap. */
export const MAX_AGENT_INSTRUCTION_CHARS = 2000;

/**
 * The card's label. The instruction is the thing the user actually chose, so
 * its first few words say far more than "Agent 3" — but a card still needs a
 * name when the instruction is empty or unhelpfully long, hence the fallback.
 */
export function agentCardLabel(
    agent: { agent_instruction?: string | null },
    index: number,
): string {
    const words = (agent.agent_instruction ?? "").trim().split(/\s+/);
    const label = words.slice(0, 4).join(" ");
    return label || `Agent ${index + 1}`;
}

/** What the dock shows under the label. */
export function agentCardInstruction(agent: {
    agent_instruction?: string | null;
}): string {
    return (agent.agent_instruction ?? "").trim();
}

/**
 * Card status, combining what the server knows with what this client is doing.
 *
 * The overlay only ever moves a card *to* processing. A server-side "ready"
 * with a live stream is still processing (the agent is answering a follow-up),
 * and an interrupted agent is "empty" — the state that offers a rerun.
 */
export type AgentCardStatus = "processing" | "ready" | "empty";

export function agentCardStatus(
    agent: Pick<ChatAgent, "status">,
    isStreaming: boolean,
): AgentCardStatus {
    if (isStreaming) return "processing";
    return agent.status;
}

/** Human-readable status, also used as the aria-live announcement. */
export function agentStatusLabel(status: AgentCardStatus): string {
    if (status === "processing") return "Processing";
    if (status === "ready") return "Ready";
    return "Needs rerun";
}

// ---------------------------------------------------------------------------
// Applying a proposal
// ---------------------------------------------------------------------------

/**
 * The outcome of accepting a proposal, before anything is sent to the server.
 *
 * `stale` is the case the contract cares about: the agent proposed a change to
 * text that has since been rewritten (by an earlier accepted proposal, usually).
 * Surfacing it as its own state is the difference between "we could not apply
 * this" and a silent no-op that claims success.
 */
export type ProposalApplication =
    | { outcome: "applied"; events: AssistantEvent[] }
    | { outcome: "stale" };

/**
 * Substitute the first occurrence of `target` with `replacement` across the
 * message's visible prose.
 *
 * Only `content` events are touched. Reasoning, tool activity and citations
 * describe the turn that produced the answer, not the answer's wording, so
 * rewriting them would misrepresent what happened.
 */
export function applyProposalToEvents(
    events: readonly AssistantEvent[] | undefined,
    target: string,
    replacement: string,
): ProposalApplication {
    if (!events || !target) return { outcome: "stale" };
    let applied = false;
    const next = events.map((event) => {
        if (applied || event.type !== "content") return event;
        const index = event.text.indexOf(target);
        if (index < 0) return event;
        applied = true;
        return {
            ...event,
            text:
                event.text.slice(0, index) +
                replacement +
                event.text.slice(index + target.length),
        };
    });
    return applied ? { outcome: "applied", events: next } : { outcome: "stale" };
}

/**
 * The prose a message currently renders, joined from its content events. Used
 * to keep `Message.content` in step after a proposal rewrites the events, so
 * anything reading the flat string (title generation, exports) sees the
 * revision too.
 */
export function assistantMessageText(
    events: readonly AssistantEvent[] | undefined,
): string {
    return (events ?? [])
        .filter(
            (event): event is Extract<AssistantEvent, { type: "content" }> =>
                event.type === "content",
        )
        .map((event) => event.text)
        .join("");
}

/**
 * Every excerpt on a response that still has an unresolved proposal against
 * it, so the reader can be shown where agents are still asking for changes.
 *
 * Keyed by the agent's assigned region rather than by each proposal's target:
 * the region is what the user highlighted and what the marker is anchored to,
 * and a proposal's own target may be a fragment of it or of the surrounding
 * text.
 */
export function pendingProposalExcerpts(
    agents: readonly ChatAgent[],
    messageId: string | undefined,
): string[] {
    if (!messageId) return [];
    const excerpts = new Set<string>();
    for (const agent of agents) {
        if (agent.source_message_id !== messageId) continue;
        if (agent.pending_proposals <= 0) continue;
        const excerpt = agent.source_excerpt?.trim();
        if (excerpt) excerpts.add(excerpt);
    }
    return [...excerpts];
}

/** The agents assigned to one response, in assignment order. */
export function agentsForMessage(
    agents: readonly ChatAgent[],
    messageId: string | undefined,
): ChatAgent[] {
    if (!messageId) return [];
    return agents.filter((agent) => agent.source_message_id === messageId);
}

/**
 * Collapse whitespace so a DOM-derived selection can be compared against
 * markdown source. A highlight that crosses a line break arrives as one run of
 * spaces; the same text in the message still carries the newline.
 */
export function normalizeForMatch(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * Which response a highlight came from.
 *
 * The selection API hands back text and a rectangle, not a message id, so the
 * excerpt is matched back against the transcript. Searching newest-first is
 * what makes a repeated phrase resolve to the response the user is actually
 * looking at.
 */
export function findSourceMessageId(
    messages: readonly Message[],
    excerpt: string,
): string | undefined {
    const needle = normalizeForMatch(excerpt);
    if (!needle) return undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role !== "assistant" || !message.id) continue;
        const haystack = normalizeForMatch(
            assistantMessageText(message.events) || message.content,
        );
        if (haystack.includes(needle)) return message.id;
    }
    return undefined;
}

/**
 * Rewrite one message inside a transcript, matching by id.
 *
 * Position-based updates are what made the old single-stream assumption hard
 * to unwind; accepting a proposal addresses a specific message that may not be
 * the last one, so it matches by id or leaves the transcript alone.
 */
export function replaceMessageById(
    messages: readonly Message[],
    messageId: string,
    updater: (message: Message) => Message,
): Message[] {
    let changed = false;
    const next = messages.map((message) => {
        if (message.id !== messageId) return message;
        changed = true;
        return updater(message);
    });
    return changed ? next : [...messages];
}
