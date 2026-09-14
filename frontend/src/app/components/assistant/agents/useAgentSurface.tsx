"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AgentDock } from "./AgentDock";
import { AgentSidePanel, type AgentPanelMode } from "./AgentSidePanel";
import { PendingProposalMarkers } from "./PendingProposalMarkers";
import type { EditProposal } from "./EditProposalCard";
import { useChatAgents } from "@/app/hooks/useChatAgents";
import {
    MAX_ACTIVE_CHAT_AGENTS,
    agentCardLabel,
    applyProposalToEvents,
    findSourceMessageId,
    pendingProposalExcerpts,
} from "@/app/lib/chatAgents";
import type { Message } from "@/app/components/shared/types";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";

interface Args {
    chatId: string | null | undefined;
    messages: readonly Message[];
    /** Called when an accepted proposal rewrote one of the transcript's messages. */
    onMessageRevised: (message: Message) => void;
}

/**
 * One integration point for the whole agents feature.
 *
 * The standalone chat and the project chat are two separate 900- and
 * 1500-line layouts that happen to render the same conversation. Rather than
 * duplicate dock state, panel state, stale-target detection and the assign
 * flow across both, this hook returns finished nodes: a `dock` to drop above
 * the composer, a `panel` to drop in the right-hand column, and a marker
 * renderer for a given message. Each surface wires three things instead of
 * thirty.
 */
export function useAgentSurface({ chatId, messages, onMessageRevised }: Args) {
    // Agents run on whatever model the parent conversation last used. The
    // choice rides on submitted user messages (there is no chat-level model
    // state), so the newest message carrying one is the conversation's model.
    // Reloaded transcripts drop the field, so the composer's persisted
    // selection — the same localStorage value ChatInput reads — is the
    // fallback that keeps agents on the model the user sees in the picker.
    const [composerModel] = useSelectedModel();
    const inheritedModel = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            const model = messages[i]?.model;
            if (model) return model;
        }
        return composerModel;
    }, [messages, composerModel]);

    const {
        agents,
        threads,
        assignError,
        clearAssignError,
        assignAgent,
        loadThread,
        sendToAgent,
        rerunAgent,
        dismissAgent,
        resolveProposal,
        atCapacity,
    } = useChatAgents(chatId, inheritedModel);

    const [mode, setMode] = useState<AgentPanelMode | null>(null);
    const [isAssigning, setIsAssigning] = useState(false);
    const [resolvingProposalIds, setResolvingProposalIds] = useState<
        ReadonlySet<string>
    >(() => new Set());

    const streamingIds = useMemo(
        () =>
            new Set(
                Object.entries(threads)
                    .filter(([, thread]) => thread.isStreaming)
                    .map(([id]) => id),
            ),
        [threads],
    );

    const openThread = useCallback(
        (agentId: string) => {
            const index = agents.findIndex((agent) => agent.id === agentId);
            const agent = agents[index];
            if (!agent) return;
            setMode({
                kind: "thread",
                agentId,
                label: agentCardLabel(agent, index),
                excerpt: agent.source_excerpt,
            });
            void loadThread(agentId);
        },
        [agents, loadThread],
    );

    /** Called by the selection popup's second action. */
    const assignFromSelection = useCallback(
        (excerpt: string) => {
            clearAssignError();
            setMode({
                kind: "assign",
                excerpt,
                sourceMessageId: findSourceMessageId(messages, excerpt),
            });
        },
        [clearAssignError, messages],
    );

    const activeAgentId = mode?.kind === "thread" ? mode.agentId : null;
    const activeAgent = agents.find((agent) => agent.id === activeAgentId);
    const activeThread = activeAgentId ? threads[activeAgentId] : undefined;

    /**
     * The response an accepted proposal would be written back to. Resolved
     * from the live transcript, not from a snapshot taken at assign time, so a
     * response revised by an earlier proposal is what the next one is checked
     * against.
     */
    const parentMessage = useMemo(
        () =>
            messages.find(
                (message) => message.id === activeAgent?.source_message_id,
            ),
        [activeAgent?.source_message_id, messages],
    );

    /**
     * Proposals whose target text is no longer in the response. Computed on
     * render rather than at accept time so the card shows "this part has
     * changed" before the user clicks, not after.
     */
    const staleProposalIds = useMemo(() => {
        const stale = new Set<string>();
        for (const message of activeThread?.messages ?? []) {
            for (const event of message.events ?? []) {
                if (event.type !== "edit_proposal") continue;
                if (event.status !== "pending") continue;
                const application = applyProposalToEvents(
                    parentMessage?.events,
                    event.target_excerpt,
                    event.replacement,
                );
                if (application.outcome === "stale") {
                    stale.add(event.proposal_id);
                }
            }
        }
        return stale;
    }, [activeThread?.messages, parentMessage?.events]);

    const [staleNotice, setStaleNotice] = useState<string | null>(null);

    const handleResolveProposal = useCallback(
        async (proposal: EditProposal, status: "accepted" | "rejected") => {
            if (!activeAgentId) return;
            setStaleNotice(null);
            setResolvingProposalIds((prev) => {
                const next = new Set(prev);
                next.add(proposal.proposal_id);
                return next;
            });
            const outcome = await resolveProposal({
                agentId: activeAgentId,
                proposal,
                status,
                parentMessage,
                onParentUpdated: onMessageRevised,
            });
            setResolvingProposalIds((prev) => {
                const next = new Set(prev);
                next.delete(proposal.proposal_id);
                return next;
            });
            if (outcome === "stale") {
                setStaleNotice(
                    "This part of the response has changed, so the edit could not be applied.",
                );
            } else if (outcome === "failed") {
                setStaleNotice(
                    "The edit could not be saved. Please try again.",
                );
            }
        },
        [activeAgentId, onMessageRevised, parentMessage, resolveProposal],
    );

    const handleAssign = useCallback(
        async (instruction: string) => {
            if (mode?.kind !== "assign") return;
            setIsAssigning(true);
            const agentId = await assignAgent({
                instruction,
                excerpt: mode.excerpt,
                sourceMessageId: mode.sourceMessageId,
            });
            setIsAssigning(false);
            if (!agentId) return;
            setMode({
                kind: "thread",
                agentId,
                label: instruction.trim().split(/\s+/).slice(0, 4).join(" "),
                excerpt: mode.excerpt,
            });
        },
        [assignAgent, mode],
    );

    const dock: ReactNode =
        agents.length > 0 ? (
            <AgentDock
                agents={agents}
                streamingIds={streamingIds}
                activeAgentId={activeAgentId}
                onOpen={openThread}
                onDismiss={(agentId) => {
                    if (activeAgentId === agentId) setMode(null);
                    void dismissAgent(agentId);
                }}
                onRerun={(agentId) => {
                    openThread(agentId);
                    void rerunAgent(agentId);
                }}
            />
        ) : null;

    const panel: ReactNode = mode ? (
        <AgentSidePanel
            mode={mode}
            messages={activeThread?.messages ?? []}
            isStreaming={!!activeThread?.isStreaming}
            threadError={staleNotice ?? activeThread?.error ?? null}
            assignError={mode.kind === "assign" ? assignError : null}
            isAssigning={isAssigning}
            resolvingProposalIds={resolvingProposalIds}
            staleProposalIds={staleProposalIds}
            onAssign={(instruction) => void handleAssign(instruction)}
            onSend={(content) => {
                if (activeAgentId) void sendToAgent(activeAgentId, content);
            }}
            onRerun={
                activeAgentId
                    ? () => void rerunAgent(activeAgentId)
                    : undefined
            }
            onResolveProposal={(proposal, status) =>
                void handleResolveProposal(proposal, status)
            }
            onClose={() => setMode(null)}
        />
    ) : null;

    /** Markers for one response's regions that still have pending proposals. */
    const markersFor = useCallback(
        (messageId: string | undefined): ReactNode => {
            const excerpts = pendingProposalExcerpts(agents, messageId);
            if (excerpts.length === 0) return null;
            return (
                <PendingProposalMarkers
                    excerpts={excerpts}
                    onOpen={(excerpt) => {
                        const agent = agents.find(
                            (candidate) =>
                                candidate.source_message_id === messageId &&
                                candidate.source_excerpt?.trim() === excerpt,
                        );
                        if (agent) openThread(agent.id);
                    }}
                />
            );
        },
        [agents, openThread],
    );

    return {
        dock,
        panel,
        panelOpen: mode !== null,
        closePanel: useCallback(() => setMode(null), []),
        assignFromSelection,
        assignDisabledReason: atCapacity
            ? `You can run ${MAX_ACTIVE_CHAT_AGENTS} agents on a response.`
            : null,
        markersFor,
    };
}
