"use client";

import { AlertTriangle, Check, X } from "lucide-react";
import type { AssistantEvent } from "@/app/components/shared/types";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";

export type EditProposal = Extract<AssistantEvent, { type: "edit_proposal" }>;

interface Props {
    proposal: EditProposal;
    /** True while this card's accept/reject request is in flight. */
    isResolving?: boolean;
    /**
     * Set when the target text is no longer present in the response — the
     * region has been edited since the agent read it, so applying would either
     * do nothing or hit the wrong place.
     */
    isStale?: boolean;
    onAccept: () => void;
    onReject: () => void;
}

/**
 * One proposed rewrite, as an accept/reject suggestion card.
 *
 * The target and the replacement are both shown, because "accept" is a
 * decision about specific wording — a card that only showed the replacement
 * would ask the user to trust that it lands where they think it does.
 */
export function EditProposalCard({
    proposal,
    isResolving,
    isStale,
    onAccept,
    onReject,
}: Props) {
    const resolved = proposal.status !== "pending";

    return (
        <div
            className={cn(
                "rounded-xl px-3 py-2 text-xs",
                LIQUID_GLASS_SUBTLE_CLASS,
            )}
        >
            <p className="mb-1.5 text-[11px] font-medium text-gray-500">
                Proposed edit
            </p>
            <p className="font-serif text-gray-500 line-through">
                {proposal.target_excerpt}
            </p>
            <p className="mt-1 font-serif text-gray-900">
                {proposal.replacement || <em>(deleted)</em>}
            </p>
            {proposal.reason && (
                <p className="mt-1.5 text-[11px] text-gray-500">
                    {proposal.reason}
                </p>
            )}

            {isStale && !resolved && (
                <p
                    role="status"
                    className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-700"
                >
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                    This part has changed, so the edit no longer applies.
                </p>
            )}

            {resolved ? (
                <p className="mt-2 text-[11px] text-gray-500">
                    {proposal.status === "accepted"
                        ? "Applied to the response."
                        : "Rejected."}
                </p>
            ) : (
                <div className="mt-2 flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={onAccept}
                        disabled={isResolving || isStale}
                        className={cn(
                            "flex h-7 cursor-pointer items-center gap-1 rounded-full bg-blue-600 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-700",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                            "disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                    >
                        <Check className="h-3 w-3" aria-hidden />
                        Accept
                    </button>
                    <button
                        type="button"
                        onClick={onReject}
                        disabled={isResolving}
                        className={cn(
                            "flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[11px] text-gray-600 transition-colors hover:text-gray-900",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                            "disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                    >
                        <X className="h-3 w-3" aria-hidden />
                        Reject
                    </button>
                </div>
            )}
        </div>
    );
}
