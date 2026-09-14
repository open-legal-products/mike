/**
 * Highlight-assigned chat agents.
 *
 * An agent is an ordinary chat row with `parent_chat_id` set. It was spawned
 * from a highlighted excerpt of one assistant response in the parent chat and
 * carries a single instruction. Because it is a real chat, it inherits the
 * whole existing stack — streaming, message persistence, access control,
 * deletion cascade — and the only things this module has to add are the rules
 * that keep the tree shallow and the extra tool an agent may call.
 *
 * Everything here is deliberately pure or IO-light so the routes stay thin and
 * the rules are unit-testable without a database.
 */

import { randomUUID } from "node:crypto";
import type { OpenAIToolSchema } from "../llm";
import type { AssistantEvent, RouteToolsAdapter } from "./streaming";

/**
 * How many live agents one response may carry. Six is a UI budget as much as a
 * server one: the dock is a single row of cards above the composer, and past
 * six the cards stop being readable at once. Enforced server-side so a client
 * that ignores the dock cannot fan out arbitrarily many concurrent streams.
 */
export const MAX_ACTIVE_CHAT_AGENTS = 6;

/** Longest instruction we accept. Roughly a paragraph. */
export const MAX_AGENT_INSTRUCTION_CHARS = 2000;

/**
 * Longest excerpt an agent can be assigned, and the longest target/replacement
 * a proposal may carry. Matches the client-side quoted-excerpt cap so the two
 * halves of the feature agree on what "too long to attach" means.
 */
export const MAX_AGENT_EXCERPT_CHARS = 4000;

type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The four assignment fields, already trimmed and length-checked. */
export type AgentAssignment = {
    parentChatId: string;
    agentInstruction: string;
    sourceMessageId: string | null;
    sourceExcerpt: string | null;
};

/**
 * Parse the optional agent fields of `POST /chat/create`.
 *
 * Returns `value: null` for an ordinary chat. `parent_chat_id` is what turns a
 * create into an assignment; the instruction then becomes mandatory, because an
 * agent with no brief has nothing to stream.
 */
export function parseOptionalAgentAssignment(
    body: unknown,
): ValidationResult<AgentAssignment | null> {
    if (!isRecord(body)) return { ok: true, value: null };
    const rawParent = body.parent_chat_id;
    if (rawParent === undefined || rawParent === null) {
        return { ok: true, value: null };
    }
    if (typeof rawParent !== "string" || !rawParent.trim()) {
        return {
            ok: false,
            detail: "parent_chat_id must be a non-empty string",
        };
    }

    const rawInstruction = body.agent_instruction;
    if (typeof rawInstruction !== "string" || !rawInstruction.trim()) {
        return {
            ok: false,
            detail: "agent_instruction must be a non-empty string",
        };
    }
    const agentInstruction = rawInstruction.trim();
    if (agentInstruction.length > MAX_AGENT_INSTRUCTION_CHARS) {
        return {
            ok: false,
            detail: `agent_instruction must be at most ${MAX_AGENT_INSTRUCTION_CHARS} characters`,
        };
    }

    const rawSourceMessageId = body.source_message_id;
    if (
        rawSourceMessageId !== undefined &&
        rawSourceMessageId !== null &&
        (typeof rawSourceMessageId !== "string" || !rawSourceMessageId.trim())
    ) {
        return {
            ok: false,
            detail: "source_message_id must be a non-empty string or null",
        };
    }

    const rawExcerpt = body.source_excerpt;
    if (
        rawExcerpt !== undefined &&
        rawExcerpt !== null &&
        typeof rawExcerpt !== "string"
    ) {
        return {
            ok: false,
            detail: "source_excerpt must be a string or null",
        };
    }
    const sourceExcerpt =
        typeof rawExcerpt === "string" ? rawExcerpt.trim() : "";
    if (sourceExcerpt.length > MAX_AGENT_EXCERPT_CHARS) {
        return {
            ok: false,
            detail: `source_excerpt must be at most ${MAX_AGENT_EXCERPT_CHARS} characters`,
        };
    }

    return {
        ok: true,
        value: {
            parentChatId: rawParent.trim(),
            agentInstruction,
            sourceMessageId:
                typeof rawSourceMessageId === "string"
                    ? rawSourceMessageId.trim()
                    : null,
            sourceExcerpt: sourceExcerpt || null,
        },
    };
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * What the server can know about an agent from its stored messages alone.
 *
 * "processing" is deliberately absent: a stream is a property of a live
 * connection, not of the database. The client overlays it while its own
 * request is open, which is also why a reload of an interrupted agent shows
 * "empty" and offers a rerun rather than a spinner that would never resolve.
 */
export type ChatAgentStatus = "ready" | "empty";

type StoredMessage = {
    role?: unknown;
    content?: unknown;
    created_at?: unknown;
};

function assistantEventsOf(message: StoredMessage): AssistantEvent[] {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return [];
    }
    return message.content as AssistantEvent[];
}

/** True when an assistant message carries something a reader would call an answer. */
function isAnsweredAssistantMessage(message: StoredMessage): boolean {
    return assistantEventsOf(message).some(
        (event) =>
            (event.type === "content" && !!event.text.trim()) ||
            event.type === "edit_proposal",
    );
}

/**
 * "ready" once the newest message is an assistant message with real content.
 * Reservations (`content: null`) and error-only turns leave the agent "empty",
 * which is what puts the rerun affordance in front of the user.
 */
export function deriveChatAgentStatus(
    messages: readonly StoredMessage[],
): ChatAgentStatus {
    const newest = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");
    return newest && isAnsweredAssistantMessage(newest) ? "ready" : "empty";
}

/** Proposals still awaiting an accept/reject, across the agent's whole thread. */
export function countPendingEditProposals(
    messages: readonly StoredMessage[],
): number {
    let pending = 0;
    for (const message of messages) {
        for (const event of assistantEventsOf(message)) {
            if (event.type === "edit_proposal" && event.status === "pending") {
                pending += 1;
            }
        }
    }
    return pending;
}

// ---------------------------------------------------------------------------
// The propose_edit tool
// ---------------------------------------------------------------------------

export const PROPOSE_EDIT_TOOL_NAME = "propose_edit";

export const PROPOSE_EDIT_TOOL: OpenAIToolSchema = {
    type: "function",
    function: {
        name: PROPOSE_EDIT_TOOL_NAME,
        description:
            "Propose a concrete rewrite of part of the original response you were assigned to. The user reviews each proposal and accepts or rejects it. Use this whenever your answer implies specific wording should change, in addition to explaining the change in prose. target_excerpt must be copied verbatim from the assigned excerpt or the surrounding response — if it does not match the text exactly, the proposal cannot be applied. Call it once per distinct change rather than proposing one sweeping rewrite.",
        parameters: {
            type: "object",
            properties: {
                target_excerpt: {
                    type: "string",
                    description:
                        "The exact text to replace, copied verbatim from the original response. Keep it as short as unambiguously possible.",
                },
                replacement: {
                    type: "string",
                    description:
                        "The text that should stand in its place. An empty string deletes the target.",
                },
                reason: {
                    type: "string",
                    description:
                        "One short sentence explaining why the change is an improvement. Shown to the user on the proposal card.",
                },
            },
            required: ["target_excerpt", "replacement"],
        },
    },
};

function cappedString(value: unknown, max: number): string {
    return typeof value === "string" ? value.slice(0, max) : "";
}

export type EditProposalEvent = Extract<
    AssistantEvent,
    { type: "edit_proposal" }
>;

/**
 * Turn one `propose_edit` call into a persisted event.
 *
 * Exported separately from the adapter so the normalization (empty target,
 * caps, id assignment) can be tested without building a tool loop.
 */
export function buildEditProposalEvent(
    input: Record<string, unknown>,
): EditProposalEvent | null {
    const targetExcerpt = cappedString(
        input.target_excerpt,
        MAX_AGENT_EXCERPT_CHARS,
    ).trim();
    // A proposal with nothing to anchor to could never be applied, so it is
    // rejected here rather than rendered as an un-acceptable card.
    if (!targetExcerpt) return null;
    const reason = cappedString(input.reason, 500).trim();
    return {
        type: "edit_proposal",
        proposal_id: randomUUID(),
        target_excerpt: targetExcerpt,
        replacement: cappedString(input.replacement, MAX_AGENT_EXCERPT_CHARS),
        reason: reason || null,
        status: "pending",
    };
}

/**
 * The `propose_edit` adapter, handed to `runLLMStream` as `routeTools`.
 *
 * Only agents get one. A normal chat passes `undefined` and the model is never
 * told the tool exists, which is the gating the feature relies on: there is no
 * "is this a sub-chat" check inside the tool, because a non-agent never has it.
 */
export function createEditProposalToolsAdapter(): RouteToolsAdapter {
    return {
        schemas: [PROPOSE_EDIT_TOOL],
        owns: (name) => name === PROPOSE_EDIT_TOOL_NAME,
        execute: async (call) => {
            const event = buildEditProposalEvent(call.input);
            if (!event) {
                return {
                    content: JSON.stringify({
                        ok: false,
                        error: "target_excerpt is required and must be non-empty.",
                    }),
                    events: [],
                };
            }
            return {
                content: JSON.stringify({
                    ok: true,
                    proposal_id: event.proposal_id,
                    note: "The proposal is shown to the user as an accept/reject card. Do not repeat its text verbatim in your prose.",
                }),
                events: [event],
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

/**
 * The extra system-prompt block an agent gets, appended to the ordinary chat
 * prompt. It is deliberately narrow: the agent's whole value is that it stays
 * on the one region it was handed instead of re-answering the conversation.
 *
 * The excerpt and instruction are user- and model-authored text. They are not
 * spotlight-fenced here because they are the agent's own brief — the fencing
 * that matters (documents, filenames, workflow titles) still happens in
 * `buildMessages`, and the seed user message carries the excerpt again as an
 * ordinary quote for the model to read as data.
 */
export function buildChatAgentSystemPrompt(agent: {
    agent_instruction?: string | null;
    source_excerpt?: string | null;
}): string {
    const lines = [
        "ASSIGNED AGENT ROLE:",
        "You are working on one specific part of an answer another assistant already gave the user. You were assigned a single excerpt of that response and a single instruction about it.",
        "- Stay on the assigned excerpt. Do not restate or re-answer the wider conversation.",
        "- Be concise and specific. The user reads you in a narrow side panel next to the original response.",
        "- When your answer implies particular wording should change, call propose_edit with the exact text to replace and its replacement, then explain the change in one or two sentences. Do not paste the rewritten passage into your prose as well.",
        "- target_excerpt must be copied verbatim from the original response, or the user will not be able to apply it.",
    ];
    const excerpt = agent.source_excerpt?.trim();
    if (excerpt) {
        lines.push("", "ASSIGNED EXCERPT:", excerpt);
    }
    const instruction = agent.agent_instruction?.trim();
    if (instruction) {
        lines.push("", "ASSIGNED INSTRUCTION:", instruction);
    }
    return lines.join("\n");
}

/**
 * The first user message an agent is seeded with.
 *
 * Encoded exactly the way the composer encodes a highlighted excerpt (preface
 * line + markdown blockquote), so the agent's own thread renders the excerpt
 * as a quote block using the same reader the parent chat uses, with no
 * agent-specific message format.
 */
export const AGENT_SEED_PREFACE =
    "Referring to this part of your earlier response:";

export function buildChatAgentSeedMessage(agent: {
    agent_instruction?: string | null;
    source_excerpt?: string | null;
}): string {
    const instruction = agent.agent_instruction?.trim() ?? "";
    const excerpt = agent.source_excerpt?.trim();
    if (!excerpt) return instruction;
    const quoted = excerpt
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    const preamble = `${AGENT_SEED_PREFACE}\n\n${quoted}`;
    return instruction ? `${preamble}\n\n${instruction}` : preamble;
}

// ---------------------------------------------------------------------------
// Applying an accepted proposal
// ---------------------------------------------------------------------------

/**
 * Validate the replacement content a client sends to
 * `PATCH /chat/:chatId/messages/:messageId`.
 *
 * The substitution itself is computed on the client (it is the same text the
 * user just saw on the proposal card, applied to the message the user is
 * looking at), so this endpoint stays a generic "replace the stored events"
 * write. What it will not accept is a shape the reader cannot render: an
 * assistant message's content is an array of events, never a bare string.
 */
export function parseAssistantMessageContent(
    value: unknown,
): ValidationResult<AssistantEvent[]> {
    if (!Array.isArray(value)) {
        return { ok: false, detail: "content must be an array of events" };
    }
    for (const [index, event] of value.entries()) {
        if (!isRecord(event) || typeof event.type !== "string" || !event.type) {
            return {
                ok: false,
                detail: `content[${index}] must be an object with a type`,
            };
        }
    }
    return { ok: true, value: value as AssistantEvent[] };
}

/**
 * Set one proposal's status inside a stored assistant message, leaving every
 * other event untouched. Returns `null` when the message carries no such
 * proposal, so the route can answer 404 rather than write an unchanged row.
 */
export function setEditProposalStatus(
    content: unknown,
    proposalId: string,
    status: "accepted" | "rejected",
): AssistantEvent[] | null {
    if (!Array.isArray(content)) return null;
    const events = content as AssistantEvent[];
    let found = false;
    const next = events.map((event) => {
        if (
            event.type !== "edit_proposal" ||
            event.proposal_id !== proposalId
        ) {
            return event;
        }
        found = true;
        return { ...event, status };
    });
    return found ? next : null;
}
