"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Loader2, RotateCw, Send, X } from "lucide-react";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import { QuotedMessageContent } from "@/app/components/shared/QuotedMessageContent";
import {
    EditProposalCard,
    type EditProposal,
} from "./EditProposalCard";
import type { Message } from "@/app/components/shared/types";
import {
    LIQUID_FLOAT_PANEL_SURFACE_CLASS,
    LIQUID_GLASS_TRANSLUCENT_CLASS,
} from "@/app/components/ui/liquid-surface";
import { MAX_AGENT_INSTRUCTION_CHARS } from "@/app/lib/chatAgents";
import { cn } from "@/app/lib/utils";

/**
 * Assign mode collects the instruction for a highlight; thread mode is one
 * agent's conversation. They share a panel because they are the same panel to
 * the user: the excerpt they highlighted, and what came back for it.
 */
export type AgentPanelMode =
    | { kind: "assign"; excerpt: string; sourceMessageId?: string }
    | { kind: "thread"; agentId: string; label: string; excerpt: string | null };

interface Props {
    mode: AgentPanelMode;
    /** Thread mode: the agent's messages. */
    messages?: readonly Message[];
    isStreaming?: boolean;
    threadError?: string | null;
    /** Assign mode: rejection text from the server (the cap, mostly). */
    assignError?: string | null;
    isAssigning?: boolean;
    /** Proposal ids currently being accepted/rejected. */
    resolvingProposalIds?: ReadonlySet<string>;
    /** Proposal ids whose target text is no longer present in the response. */
    staleProposalIds?: ReadonlySet<string>;
    onAssign?: (instruction: string) => void;
    onSend?: (content: string) => void;
    onRerun?: () => void;
    onResolveProposal?: (
        proposal: EditProposal,
        status: "accepted" | "rejected",
    ) => void;
    onClose: () => void;
}

const MIN_WIDTH = 320;
const MAX_WIDTH_OFFSET = 56; // sidebar width
const MIN_CHAT_WIDTH = 400;

function maxPanelWidth() {
    if (typeof window === "undefined") return 520;
    return Math.max(
        MIN_WIDTH,
        window.innerWidth - MAX_WIDTH_OFFSET - MIN_CHAT_WIDTH,
    );
}

/**
 * The right-hand panel for assigned agents.
 *
 * It deliberately does not join `AssistantSidePanel`'s tab strip: every tab
 * there is a document version, and an agent thread has no document. Sharing the
 * strip would mean widening that type until "document" was optional, which is
 * how a focused component turns into a switchboard. The frame, resize handle,
 * and glass surface are the same.
 */
export function AgentSidePanel({
    mode,
    messages = [],
    isStreaming = false,
    threadError = null,
    assignError = null,
    isAssigning = false,
    resolvingProposalIds,
    staleProposalIds,
    onAssign,
    onSend,
    onRerun,
    onResolveProposal,
    onClose,
}: Props) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [panelWidth, setPanelWidth] = useState(() =>
        typeof window !== "undefined"
            ? Math.min(
                  maxPanelWidth(),
                  Math.round((window.innerWidth - MAX_WIDTH_OFFSET) / 2.5),
              )
            : 520,
    );
    const dragStartX = useRef(0);
    const dragStartWidth = useRef(0);
    const [draft, setDraft] = useState("");
    const scrollerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onResize = () =>
            setPanelWidth((width) =>
                Math.min(maxPanelWidth(), Math.max(MIN_WIDTH, width)),
            );
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    // Switching between assign and one agent's thread is a different task; a
    // half-typed instruction must not leak into the next agent's composer.
    const modeKey = mode.kind === "assign" ? "assign" : mode.agentId;
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft belongs to whichever agent the panel is showing
        setDraft("");
    }, [modeKey]);

    useEffect(() => {
        const scroller = scrollerRef.current;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }, [messages, isStreaming]);

    const onMouseDown = (event: React.MouseEvent) => {
        event.preventDefault();
        dragStartX.current = event.clientX;
        dragStartWidth.current = panelRef.current?.offsetWidth ?? panelWidth;
        const onMouseMove = (moveEvent: MouseEvent) => {
            const delta = dragStartX.current - moveEvent.clientX;
            setPanelWidth(
                Math.min(
                    maxPanelWidth(),
                    Math.max(MIN_WIDTH, dragStartWidth.current + delta),
                ),
            );
        };
        const onMouseUp = () => {
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    const heading = mode.kind === "assign" ? "Assign to agent" : mode.label;
    const excerpt = mode.kind === "assign" ? mode.excerpt : mode.excerpt;
    const canSubmit = draft.trim().length > 0;

    const submit = () => {
        if (!canSubmit) return;
        if (mode.kind === "assign") onAssign?.(draft.trim());
        else onSend?.(draft.trim());
        setDraft("");
    };

    return (
        <div
            ref={panelRef}
            className={cn(
                "relative flex h-full w-full shrink-0 flex-col md:my-3 md:mr-3 md:h-[calc(100%-1.5rem)] md:w-[var(--agent-panel-width)]",
                LIQUID_FLOAT_PANEL_SURFACE_CLASS,
                "overflow-hidden",
            )}
            style={
                { "--agent-panel-width": `${panelWidth}px` } as CSSProperties
            }
        >
            <div
                onMouseDown={onMouseDown}
                className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize transition-colors hover:bg-blue-400/70 md:block"
                style={{ marginLeft: -2 }}
            />

            <div className="flex items-start gap-2 px-4 pt-3">
                <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-medium text-gray-900">
                        {heading}
                    </h2>
                    {excerpt && (
                        <blockquote className="mt-1.5 max-h-24 overflow-y-auto border-l-2 border-gray-200 pl-2 font-serif text-xs text-gray-600">
                            {excerpt}
                        </blockquote>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close agent panel"
                    className={cn(
                        "shrink-0 cursor-pointer rounded-full p-1.5 text-gray-400 transition-colors hover:text-gray-700",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                    )}
                >
                    <X className="h-4 w-4" aria-hidden />
                </button>
            </div>

            <div
                ref={scrollerRef}
                className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-3"
            >
                {mode.kind === "assign" ? (
                    <p className="text-xs text-gray-500">
                        The agent reads only this excerpt. Tell it what to do
                        with it — check a claim, tighten the wording, find the
                        counter-argument.
                    </p>
                ) : (
                    <AgentThread
                        messages={messages}
                        isStreaming={isStreaming}
                        error={threadError}
                        resolvingProposalIds={resolvingProposalIds}
                        staleProposalIds={staleProposalIds}
                        onResolveProposal={onResolveProposal}
                        onRerun={onRerun}
                    />
                )}
            </div>

            <div className="px-3 pb-3">
                {(assignError || threadError) && (
                    <p
                        role="status"
                        className="mb-1.5 px-1 text-[11px] text-red-600"
                    >
                        {assignError ?? threadError}
                    </p>
                )}
                <div
                    className={cn(
                        "flex items-end gap-1.5 rounded-2xl px-2 py-1.5",
                        LIQUID_GLASS_TRANSLUCENT_CLASS,
                    )}
                >
                    <textarea
                        value={draft}
                        maxLength={MAX_AGENT_INSTRUCTION_CHARS}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                submit();
                            }
                        }}
                        rows={2}
                        aria-label={
                            mode.kind === "assign"
                                ? "What should this agent do?"
                                : "Message this agent"
                        }
                        placeholder={
                            mode.kind === "assign"
                                ? "What should this agent do?"
                                : "Reply to this agent…"
                        }
                        className="max-h-32 min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-xs text-gray-900 outline-none placeholder:text-gray-400"
                    />
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!canSubmit || isAssigning}
                        aria-label={mode.kind === "assign" ? "Assign" : "Send"}
                        className={cn(
                            "mb-1 flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-700",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                            "disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                    >
                        {isAssigning ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                            <Send className="h-3.5 w-3.5" aria-hidden />
                        )}
                        {mode.kind === "assign" ? "Assign" : "Send"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function AgentThread({
    messages,
    isStreaming,
    error,
    resolvingProposalIds,
    staleProposalIds,
    onResolveProposal,
    onRerun,
}: {
    messages: readonly Message[];
    isStreaming: boolean;
    error: string | null;
    resolvingProposalIds?: ReadonlySet<string>;
    staleProposalIds?: ReadonlySet<string>;
    onResolveProposal?: (
        proposal: EditProposal,
        status: "accepted" | "rejected",
    ) => void;
    onRerun?: () => void;
}) {
    // An agent with nothing in it is an agent whose stream never finished —
    // the honest offer is to run it again, not a spinner that cannot resolve.
    if (messages.length === 0 && !isStreaming) {
        return (
            <div className="space-y-2">
                <p className="text-xs text-gray-500">
                    {error ?? "This agent has not answered yet."}
                </p>
                {onRerun && (
                    <button
                        type="button"
                        onClick={onRerun}
                        className={cn(
                            "flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] text-gray-700 transition-colors hover:text-gray-900",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                        )}
                    >
                        <RotateCw className="h-3 w-3" aria-hidden />
                        Run it again
                    </button>
                )}
            </div>
        );
    }

    return (
        <>
            {messages.map((message, index) => {
                if (message.role === "user") {
                    return (
                        <div key={message.id ?? index} className="flex justify-end">
                            <div className="max-w-[85%] rounded-2xl bg-app-surface-active px-3 py-2">
                                <QuotedMessageContent
                                    content={message.content}
                                    className="text-xs text-gray-900"
                                />
                            </div>
                        </div>
                    );
                }
                const proposals = (message.events ?? []).filter(
                    (event): event is EditProposal =>
                        event.type === "edit_proposal",
                );
                return (
                    <div key={message.id ?? index} className="space-y-2">
                        <AssistantMessage
                            events={message.events}
                            isStreaming={
                                index === messages.length - 1 && isStreaming
                            }
                            isError={!!message.error}
                            errorMessage={
                                typeof message.error === "string"
                                    ? message.error
                                    : undefined
                            }
                            citations={message.citations}
                            citationStatus={message.citationStatus}
                        />
                        {proposals.map((proposal) => (
                            <EditProposalCard
                                key={proposal.proposal_id}
                                proposal={proposal}
                                isResolving={resolvingProposalIds?.has(
                                    proposal.proposal_id,
                                )}
                                isStale={staleProposalIds?.has(
                                    proposal.proposal_id,
                                )}
                                onAccept={() =>
                                    onResolveProposal?.(proposal, "accepted")
                                }
                                onReject={() =>
                                    onResolveProposal?.(proposal, "rejected")
                                }
                            />
                        ))}
                    </div>
                );
            })}
        </>
    );
}
