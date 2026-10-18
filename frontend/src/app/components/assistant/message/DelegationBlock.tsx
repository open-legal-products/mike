import { useState, type ReactNode } from "react";
import type { DelegationEffort } from "@mike/contracts";
import { modelDisplayName } from "@/shared/lib/modelCatalog";
import type { AssistantEvent } from "../../shared/types";
import { EventBlock, ReasoningContent } from "./EventBlocks";
import { EventDisclosureButton } from "./EventDisclosure";
import { isRenderableEvent, toolCallLabel } from "./eventUtils";

type DelegationEvent = Extract<AssistantEvent, { type: "delegation" }>;

const EFFORT_LABELS: Record<DelegationEffort, string> = {
    quick: "Quick effort",
    standard: "Standard effort",
    deep: "Deep effort",
};

const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact" });

function summarize(event: DelegationEvent): {
    label: string;
    dotColor: "green" | "gray" | "red";
    details: Array<string | false | undefined>;
} {
    const continued = !!event.continued_from;
    if (event.isStreaming) {
        return {
            label: continued ? "Continuing" : "Delegating",
            dotColor: "gray",
            details: [toolCallLabel(event.activity ?? "")],
        };
    }
    const stepCount = event.events.filter(isRenderableEvent).length;
    const steps = stepCount > 0 && `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
    const effort = event.effort && EFFORT_LABELS[event.effort];
    const model = event.model && modelDisplayName(event.model);
    const tokens =
        event.usage &&
        `${compactNumber.format(event.usage.input_tokens + event.usage.output_tokens)} tokens`;
    switch (event.status) {
        case "completed":
            return {
                label: continued ? "Continued" : "Delegated",
                dotColor: "green",
                details: [steps, effort, model, tokens],
            };
        case "incomplete":
            return {
                label: "Delegation incomplete",
                dotColor: "gray",
                details: [
                    event.effort ? `Reached its ${event.effort} effort limit` : "Reached its limit",
                    !!event.brief && "Partial brief",
                    steps,
                    model,
                    tokens,
                ],
            };
        case "needs_input":
            if (event.approval_ids?.length) {
                return {
                    label: "Asking for approval",
                    dotColor: "gray",
                    details: [steps, model],
                };
            }
            return {
                label: "Asked for input",
                dotColor: "gray",
                details: ["Waiting for an answer"],
            };
        case "failed":
            return {
                label: "Delegation failed",
                dotColor: "red",
                details: ["The subagent could not finish", model, tokens],
            };
        case "cancelled":
        default:
            return {
                label: "Delegation stopped",
                dotColor: "gray",
                details: [steps],
            };
    }
}

function BriefDisclosure({ brief, partial }: { brief: string; partial: boolean }) {
    const [open, setOpen] = useState(false);
    return (
        <EventBlock dotColor="gray">
            <EventDisclosureButton
                open={open}
                onToggle={() => setOpen((value) => !value)}
                label={partial ? "Returned a partial brief" : "Returned a brief"}
            />
            {open && <ReasoningContent text={brief} label="Brief" />}
        </EventBlock>
    );
}

export function DelegationBlock({
    event,
    showConnector,
    renderSteps,
}: {
    event: DelegationEvent;
    showConnector?: boolean;
    renderSteps: (steps: AssistantEvent[]) => ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const { label, dotColor, details } = summarize(event);

    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={event.isStreaming}
            dotColor={dotColor}
        >
            <EventDisclosureButton
                open={open}
                onToggle={() => setOpen((value) => !value)}
                label={label}
                detail={<span className="[overflow-wrap:anywhere]">{event.title}</span>}
                isStreaming={event.isStreaming}
            />
            <p
                className={`mt-0.5 text-xs [overflow-wrap:anywhere] ${
                    event.status === "failed" ? "text-red-600" : "text-gray-400"
                }`}
            >
                {details.filter(Boolean).join(" · ")}
            </p>
            {open && (
                <div className="mt-2 flex flex-col gap-4">
                    <p className="whitespace-pre-wrap text-gray-600 [overflow-wrap:anywhere]">
                        {event.task}
                    </p>
                    {event.isStreaming ? (
                        <p className="text-xs text-gray-400">
                            Steps appear when the subagent finishes.
                        </p>
                    ) : (
                        renderSteps(event.events)
                    )}
                    {event.question && (
                        <p className="whitespace-pre-wrap text-gray-800 [overflow-wrap:anywhere]">
                            {event.question}
                        </p>
                    )}
                    {event.brief && (
                        <BriefDisclosure
                            brief={event.brief}
                            partial={event.status === "incomplete"}
                        />
                    )}
                </div>
            )}
        </EventBlock>
    );
}
