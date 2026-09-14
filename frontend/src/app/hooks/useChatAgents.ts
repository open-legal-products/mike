"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    createChatAgent,
    getChat,
    listChatAgents,
    resolveEditProposal,
    streamChat,
    updateChatMessageContent,
} from "@/app/lib/mikeApi";
import {
    AssistantEventBuffer,
    appendCancellationEvent,
    applyAssistantStreamFrame,
    consumeAssistantSseStream,
} from "@/app/hooks/assistantStream";
import {
    MAX_ACTIVE_CHAT_AGENTS,
    applyProposalToEvents,
    assistantMessageText,
    replaceMessageById,
} from "@/app/lib/chatAgents";
import {
    QUOTED_EXCERPT_PREFACE,
    buildQuotedMessageContent,
} from "@/app/lib/quotedExcerpts";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type {
    AssistantEvent,
    ChatAgent,
    Message,
} from "@/app/components/shared/types";

/** One agent's live thread, as the panel and the dock need it. */
export interface AgentThread {
    messages: Message[];
    isStreaming: boolean;
    /** Set when the agent's own request failed, distinct from a model error. */
    error: string | null;
    /** True once its transcript has been fetched from the server. */
    loaded: boolean;
}

/**
 * Generic fallback for an agent request that failed for a reason the API did
 * not spell out. Intentional 4xx detail (the cap, a missing parent) is passed
 * through by `userFacingApiError`.
 */
const AGENT_FAILURE_MESSAGE = "The agent could not be started. Please try again.";

const EMPTY_THREAD: AgentThread = {
    messages: [],
    isStreaming: false,
    error: null,
    loaded: false,
};

/**
 * The runtime behind the agent dock and the agent side panel.
 *
 * Its whole reason for existing is that up to seven assistant streams — the
 * parent chat's and one per agent — can be open at once. React hooks cannot be
 * created per agent, so instead of N `useAssistantChat` instances this owns one
 * `AssistantEventBuffer` and one `AbortController` per agent id, in refs, and
 * publishes their state as a plain `Record<agentId, AgentThread>`. Nothing is
 * module-scoped: two chats rendered in one session get two independent
 * runtimes.
 */
export function useChatAgents(
    parentChatId: string | null | undefined,
    model?: string | null,
) {
    const [agents, setAgents] = useState<ChatAgent[]>([]);
    const [threads, setThreads] = useState<Record<string, AgentThread>>({});
    const [assignError, setAssignError] = useState<string | null>(null);

    // The parent conversation's model choice lives on its submitted messages,
    // not in any global state; a ref keeps the latest value visible to turns
    // already in flight without re-creating their callbacks.
    const modelRef = useRef<string | null | undefined>(model);
    modelRef.current = model;

    // Per-agent stream state. Refs rather than state because a mid-stream
    // buffer mutation must not wait for a render to be visible to the next
    // frame of the same stream.
    const buffersRef = useRef(new Map<string, AssistantEventBuffer>());
    const controllersRef = useRef(new Map<string, AbortController>());
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        // Captured for the cleanup: the Map identity never changes, but the
        // lint rule cannot know that from a ref read.
        const controllers = controllersRef.current;
        return () => {
            mountedRef.current = false;
            // Leaving the chat should not leave seven sockets open.
            for (const controller of controllers.values()) {
                controller.abort();
            }
            controllers.clear();
        };
    }, []);

    const patchThread = useCallback(
        (agentId: string, patch: Partial<AgentThread>) => {
            if (!mountedRef.current) return;
            setThreads((prev) => ({
                ...prev,
                [agentId]: { ...(prev[agentId] ?? EMPTY_THREAD), ...patch },
            }));
        },
        [],
    );

    /** Rewrite the newest assistant message of one agent's thread. */
    const patchLatestAssistant = useCallback(
        (agentId: string, updater: (message: Message) => Message) => {
            if (!mountedRef.current) return;
            setThreads((prev) => {
                const thread = prev[agentId] ?? EMPTY_THREAD;
                const index = [...thread.messages]
                    .map((message, i) => ({ message, i }))
                    .reverse()
                    .find(({ message }) => message.role === "assistant")?.i;
                if (index === undefined) return prev;
                const messages = [...thread.messages];
                messages[index] = updater(messages[index]);
                return { ...prev, [agentId]: { ...thread, messages } };
            });
        },
        [],
    );

    const bufferFor = useCallback(
        (agentId: string) => {
            let buffer = buffersRef.current.get(agentId);
            if (!buffer) {
                buffer = new AssistantEventBuffer((events) =>
                    patchLatestAssistant(agentId, (message) => ({
                        ...message,
                        events,
                    })),
                );
                buffersRef.current.set(agentId, buffer);
            }
            return buffer;
        },
        [patchLatestAssistant],
    );

    const refreshAgents = useCallback(async () => {
        if (!parentChatId) {
            setAgents([]);
            return;
        }
        try {
            const next = await listChatAgents(parentChatId);
            if (mountedRef.current) setAgents(next);
        } catch {
            // A dock that cannot list is a dock that shows nothing; the chat
            // itself is unaffected, so this stays quiet rather than throwing an
            // error banner over a working conversation.
        }
    }, [parentChatId]);

    useEffect(() => {
        setAgents([]);
        setThreads({});
        buffersRef.current.clear();
        void refreshAgents();
    }, [refreshAgents]);

    /**
     * Run one turn against an agent's chat.
     *
     * `seed` is already-encoded message content; the caller decides whether it
     * is the assignment seed or a follow-up the user typed in the panel.
     */
    const runTurn = useCallback(
        async (agentId: string, content: string, history: Message[]) => {
            const buffer = bufferFor(agentId);
            const controller = new AbortController();
            controllersRef.current.get(agentId)?.abort();
            controllersRef.current.set(agentId, controller);

            const userMessage: Message = { role: "user", content };
            const turnMessages = [...history, userMessage];
            buffer.reset([]);
            patchThread(agentId, {
                messages: [
                    ...turnMessages,
                    { role: "assistant", content: "", citations: [], events: [] },
                ],
                isStreaming: true,
                error: null,
                loaded: true,
            });

            try {
                const response = await streamChat({
                    messages: turnMessages.map((message) => ({
                        role: message.role,
                        content: message.content,
                    })),
                    chat_id: agentId,
                    // Without this an agent falls back to the server's default
                    // model even when the conversation it was spawned from is
                    // running on a different one — and fails outright if the
                    // default provider has no key configured.
                    model: modelRef.current ?? undefined,
                    signal: controller.signal,
                });
                if (!response.ok) {
                    await response.body?.cancel().catch(() => {});
                    throw new Error(
                        `Agent request failed with status ${response.status}`,
                    );
                }

                await consumeAssistantSseStream(response, (data) =>
                    // No onChatId / onChatTitle / router handlers: an agent
                    // must never move the app's current chat pointer or the
                    // URL out from under the conversation the user is reading.
                    applyAssistantStreamFrame(data, buffer, {
                        onError: (message) =>
                            patchLatestAssistant(agentId, (assistant) => ({
                                ...assistant,
                                events: buffer.snapshot(),
                                error: message,
                            })),
                        onCitations: (citations, status) =>
                            patchLatestAssistant(agentId, (assistant) => ({
                                ...assistant,
                                citations,
                                citationStatus:
                                    status === "final"
                                        ? citations.length
                                            ? "final"
                                            : undefined
                                        : status,
                            })),
                    }),
                );

                buffer.finalizeReasoning();
                patchThread(agentId, { isStreaming: false });
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                    const events = appendCancellationEvent(buffer.snapshot());
                    buffer.reset(events);
                    patchLatestAssistant(agentId, (assistant) => ({
                        ...assistant,
                        events,
                    }));
                } else {
                    patchLatestAssistant(agentId, (assistant) => ({
                        ...assistant,
                        error: userFacingApiError(error, AGENT_FAILURE_MESSAGE),
                    }));
                }
                patchThread(agentId, { isStreaming: false });
            } finally {
                if (controllersRef.current.get(agentId) === controller) {
                    controllersRef.current.delete(agentId);
                }
                void refreshAgents();
            }
        },
        [bufferFor, patchLatestAssistant, patchThread, refreshAgents],
    );

    /**
     * Assign a highlighted excerpt to a new agent and start it streaming.
     *
     * Returns the new agent's id so the caller can open its thread straight
     * away — the panel switches from "assign" to "thread" without waiting for
     * the first token.
     */
    const assignAgent = useCallback(
        async (args: {
            instruction: string;
            excerpt: string;
            sourceMessageId?: string;
        }): Promise<string | null> => {
            if (!parentChatId) return null;
            setAssignError(null);
            if (agents.length >= MAX_ACTIVE_CHAT_AGENTS) {
                setAssignError(
                    `You can run ${MAX_ACTIVE_CHAT_AGENTS} agents on a response. Dismiss one to assign another.`,
                );
                return null;
            }
            try {
                const created = await createChatAgent({
                    parent_chat_id: parentChatId,
                    agent_instruction: args.instruction,
                    source_message_id: args.sourceMessageId ?? null,
                    source_excerpt: args.excerpt || null,
                });
                const agent: ChatAgent = {
                    id: created.id,
                    title: created.title,
                    agent_instruction: created.agent_instruction,
                    source_message_id: created.source_message_id,
                    source_excerpt: created.source_excerpt,
                    created_at: created.created_at,
                    status: "empty",
                    pending_proposals: 0,
                };
                setAgents((prev) => [...prev, agent]);
                // The excerpt rides in as a quoted block, the same encoding the
                // composer uses, so the agent's own thread renders it as a
                // quote with no agent-specific message format.
                void runTurn(
                    created.id,
                    buildQuotedMessageContent(
                        args.excerpt ? [args.excerpt] : [],
                        args.instruction,
                    ),
                    [],
                );
                return created.id;
            } catch (error) {
                setAssignError(userFacingApiError(error, AGENT_FAILURE_MESSAGE));
                return null;
            }
        },
        [agents.length, parentChatId, runTurn],
    );

    /** Load an agent's stored transcript the first time its thread is opened. */
    const loadThread = useCallback(
        async (agentId: string) => {
            if (threads[agentId]?.loaded || threads[agentId]?.isStreaming) {
                return;
            }
            try {
                const detail = await getChat(agentId);
                patchThread(agentId, {
                    messages: detail.messages,
                    loaded: true,
                });
            } catch (error) {
                patchThread(agentId, {
                    loaded: true,
                    error: userFacingApiError(error, AGENT_FAILURE_MESSAGE),
                });
            }
        },
        [patchThread, threads],
    );

    /** Continue an agent's thread from the panel composer. */
    const sendToAgent = useCallback(
        async (agentId: string, content: string) => {
            if (!content.trim()) return;
            await runTurn(
                agentId,
                content.trim(),
                threads[agentId]?.messages ?? [],
            );
        },
        [runTurn, threads],
    );

    /**
     * Re-send an agent's original brief. Offered when an agent comes back from
     * a reload with no answer, which is what an interrupted stream looks like
     * once the connection that was carrying it is gone.
     */
    const rerunAgent = useCallback(
        async (agentId: string) => {
            const agent = agents.find((candidate) => candidate.id === agentId);
            if (!agent) return;
            await runTurn(
                agentId,
                buildQuotedMessageContent(
                    agent.source_excerpt ? [agent.source_excerpt] : [],
                    agent.agent_instruction ?? "",
                ),
                [],
            );
        },
        [agents, runTurn],
    );

    const cancelAgent = useCallback((agentId: string) => {
        controllersRef.current.get(agentId)?.abort();
    }, []);

    /** Dismissing a card deletes the agent; the cascade takes its messages. */
    const dismissAgent = useCallback(
        async (agentId: string) => {
            controllersRef.current.get(agentId)?.abort();
            controllersRef.current.delete(agentId);
            buffersRef.current.delete(agentId);
            setAgents((prev) => prev.filter((agent) => agent.id !== agentId));
            setThreads((prev) => {
                const next = { ...prev };
                delete next[agentId];
                return next;
            });
            const { deleteChat } = await import("@/app/lib/mikeApi");
            try {
                await deleteChat(agentId);
            } finally {
                void refreshAgents();
            }
        },
        [refreshAgents],
    );

    /**
     * Accept or reject one proposal.
     *
     * Accepting is two writes: the parent response is rewritten, then the card
     * is marked resolved. The rewrite goes first — if the target text has moved
     * on, nothing is written at all and the caller is told the region is stale,
     * rather than the card quietly going green over an unchanged response.
     */
    const resolveProposal = useCallback(
        async (args: {
            agentId: string;
            proposal: Extract<AssistantEvent, { type: "edit_proposal" }>;
            status: "accepted" | "rejected";
            parentMessage?: Message;
            onParentUpdated?: (message: Message) => void;
        }): Promise<"applied" | "rejected" | "stale" | "failed"> => {
            const { agentId, proposal, status } = args;
            let updatedParent: Message | null = null;

            if (status === "accepted") {
                if (!parentChatId || !args.parentMessage?.id) return "stale";
                const application = applyProposalToEvents(
                    args.parentMessage.events,
                    proposal.target_excerpt,
                    proposal.replacement,
                );
                if (application.outcome === "stale") return "stale";
                try {
                    const saved = await updateChatMessageContent(
                        parentChatId,
                        args.parentMessage.id,
                        application.events,
                    );
                    updatedParent = {
                        ...args.parentMessage,
                        events: application.events,
                        content: assistantMessageText(application.events),
                        edited_at: saved.edited_at,
                    };
                } catch {
                    return "failed";
                }
            }

            try {
                await resolveEditProposal(agentId, proposal.proposal_id, status);
            } catch {
                return "failed";
            }

            // Reflect the resolution in the agent's own thread immediately; the
            // card is the thing the user just clicked.
            setThreads((prev) => {
                const thread = prev[agentId];
                if (!thread) return prev;
                return {
                    ...prev,
                    [agentId]: {
                        ...thread,
                        messages: thread.messages.map((message) =>
                            message.role === "assistant"
                                ? {
                                      ...message,
                                      events: message.events?.map((event) =>
                                          event.type === "edit_proposal" &&
                                          event.proposal_id ===
                                              proposal.proposal_id
                                              ? { ...event, status }
                                              : event,
                                      ),
                                  }
                                : message,
                        ),
                    },
                };
            });
            if (updatedParent) args.onParentUpdated?.(updatedParent);
            void refreshAgents();
            return status === "accepted" ? "applied" : "rejected";
        },
        [parentChatId, refreshAgents],
    );

    return {
        agents,
        threads,
        assignError,
        clearAssignError: useCallback(() => setAssignError(null), []),
        assignAgent,
        loadThread,
        sendToAgent,
        rerunAgent,
        cancelAgent,
        dismissAgent,
        resolveProposal,
        refreshAgents,
        atCapacity: agents.length >= MAX_ACTIVE_CHAT_AGENTS,
    };
}

export { QUOTED_EXCERPT_PREFACE, replaceMessageById };
