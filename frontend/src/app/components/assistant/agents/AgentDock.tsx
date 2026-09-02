"use client";

import { Check, Loader2, RotateCw, X } from "lucide-react";
import type { ChatAgent } from "@/app/components/shared/types";
import {
    agentCardInstruction,
    agentCardLabel,
    agentCardStatus,
    agentStatusLabel,
} from "@/app/lib/chatAgents";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";

interface Props {
    agents: readonly ChatAgent[];
    /** Ids of the agents whose stream this client currently has open. */
    streamingIds: ReadonlySet<string>;
    activeAgentId: string | null;
    onOpen: (agentId: string) => void;
    onDismiss: (agentId: string) => void;
    onRerun: (agentId: string) => void;
}

/**
 * The row of agent cards that sits above the composer.
 *
 * One card per agent assigned to this conversation, each showing what it was
 * asked, whether it is still working, and how many of its proposed edits are
 * still waiting on the user. Status changes are announced through an
 * `aria-live` region so a reader who is not watching the dock still hears an
 * agent finish.
 */
export function AgentDock({
    agents,
    streamingIds,
    activeAgentId,
    onOpen,
    onDismiss,
    onRerun,
}: Props) {
    if (agents.length === 0) return null;

    return (
        <div className="px-2 pb-2">
            <ul
                aria-label="Assigned agents"
                className="flex items-stretch gap-2 overflow-x-auto pb-1"
            >
                {agents.map((agent, index) => {
                    const streaming = streamingIds.has(agent.id);
                    const status = agentCardStatus(agent, streaming);
                    const label = agentCardLabel(agent, index);
                    const instruction = agentCardInstruction(agent);
                    const isActive = agent.id === agentId(activeAgentId);
                    return (
                        <li key={agent.id} className="min-w-0 shrink-0">
                            <div
                                className={cn(
                                    "group relative flex w-52 items-start gap-2 rounded-xl px-3 py-2",
                                    LIQUID_GLASS_SUBTLE_CLASS,
                                    isActive
                                        ? LIQUID_GLASS_SELECTED_CLASS
                                        : LIQUID_GLASS_HOVER_CLASS,
                                )}
                            >
                                <button
                                    type="button"
                                    onClick={() => onOpen(agent.id)}
                                    aria-pressed={isActive}
                                    // The card's visible text is the label plus
                                    // the instruction it was cut from, which
                                    // reads as a stutter. The name keeps the
                                    // visible label and says what clicking does.
                                    aria-label={`Open ${label}`}
                                    className={cn(
                                        "min-w-0 flex-1 cursor-pointer text-left",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 rounded-lg",
                                    )}
                                >
                                    <span className="flex items-center gap-1.5">
                                        <StatusDot status={status} />
                                        <span className="truncate text-xs font-medium text-gray-900">
                                            {label}
                                        </span>
                                        {agent.pending_proposals > 0 && (
                                            <span
                                                className="ml-auto shrink-0 rounded-full bg-blue-100 px-1.5 text-[10px] font-medium text-blue-700"
                                                aria-label={`${agent.pending_proposals} proposed ${
                                                    agent.pending_proposals ===
                                                    1
                                                        ? "edit"
                                                        : "edits"
                                                } awaiting review`}
                                            >
                                                {agent.pending_proposals}
                                            </span>
                                        )}
                                    </span>
                                    <span className="mt-0.5 block truncate text-[11px] text-gray-500">
                                        {instruction || agentStatusLabel(status)}
                                    </span>
                                </button>
                                {status === "empty" && !streaming && (
                                    <button
                                        type="button"
                                        onClick={() => onRerun(agent.id)}
                                        aria-label={`Rerun ${label}`}
                                        className={cn(
                                            "shrink-0 cursor-pointer rounded-full p-1 text-gray-400 transition-colors hover:text-gray-700",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                                        )}
                                    >
                                        <RotateCw
                                            className="h-3 w-3"
                                            aria-hidden
                                        />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => onDismiss(agent.id)}
                                    aria-label={`Dismiss ${label}`}
                                    className={cn(
                                        "shrink-0 cursor-pointer rounded-full p-1 text-gray-400 transition-colors hover:text-gray-700",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                                    )}
                                >
                                    <X className="h-3 w-3" aria-hidden />
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>
            <p aria-live="polite" className="sr-only">
                {agents
                    .map(
                        (agent, index) =>
                            `${agentCardLabel(agent, index)}: ${agentStatusLabel(
                                agentCardStatus(agent, streamingIds.has(agent.id)),
                            )}`,
                    )
                    .join(". ")}
            </p>
        </div>
    );
}

function agentId(value: string | null) {
    return value ?? "";
}

function StatusDot({
    status,
}: {
    status: "processing" | "ready" | "empty";
}) {
    if (status === "processing") {
        return (
            <Loader2
                className="h-3 w-3 shrink-0 animate-spin text-blue-600"
                aria-hidden
            />
        );
    }
    if (status === "ready") {
        return (
            <Check className="h-3 w-3 shrink-0 text-green-600" aria-hidden />
        );
    }
    return (
        <span
            className="h-2 w-2 shrink-0 rounded-full bg-gray-300 ring-1 ring-inset ring-gray-400"
            aria-hidden
        />
    );
}
