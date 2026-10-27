import { useId, useState, type ReactNode } from "react";
import { MIKE_ICON_TINTS, MikeIcon, type MikeIconTint } from "@/shared/ui/MikeIconUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import type { AssistantEvent } from "../../shared/types";
import { EventBlock, ReasoningContent } from "./EventBlocks";
import { EventChevron, EventDisclosureButton, EventLabel } from "./EventDisclosure";
import { isRenderableEvent, toolCallLabel } from "./eventUtils";
import { subagentDetailsText } from "./responseDetails";

export type DelegationEvent = Extract<AssistantEvent, { type: "delegation" }>;

type RenderSteps = (steps: AssistantEvent[], connectsToNextRow: boolean) => ReactNode;

const subagents = (count: number) => (count === 1 ? "subagent" : "subagents");

/** generate_visual and edit_visual run the builder, which returns a report, not a brief. */
const isVisualBuild = (event: DelegationEvent) => event.kind === "visual";

/**
 * "Started 2 subagents", "Resumed a subagent", "Started 1 and resumed 1
 * subagents": what Mike did, on its own line above the subagents' pills.
 */
function startedLabel(delegations: DelegationEvent[]): string {
    if (delegations.every(isVisualBuild)) {
        return delegations.length === 1
            ? "Started a visual build"
            : `Started ${delegations.length} visual builds`;
    }
    const resumed = delegations.filter((d) => d.continued_from).length;
    const started = delegations.length - resumed;
    if (started && resumed) {
        return `Started ${started} and resumed ${resumed} ${subagents(delegations.length)}`;
    }
    const verb = resumed ? "Resumed" : "Started";
    return delegations.length === 1
        ? `${verb} a subagent`
        : `${verb} ${delegations.length} subagents`;
}

function stepCount(event: DelegationEvent): number {
    return event.events.filter(isRenderableEvent).length;
}

/** A subagent's status line: how it is doing or how it ended. */
function subagentStatus(event: DelegationEvent): { text: string; failed: boolean } {
    const count = stepCount(event);
    const steps = count > 0 ? `${count} ${count === 1 ? "step" : "steps"}` : null;
    const line = (...parts: Array<string | null | false | undefined>) => ({
        text: parts.filter(Boolean).join(" · "),
        failed: false,
    });
    const resumed = !!event.continued_from && "Resumed";
    if (event.isStreaming) {
        return line(resumed || "Running", toolCallLabel(event.activity ?? ""));
    }
    switch (event.status) {
        case "completed":
            // Worded like the timeline's own "Completed in N steps".
            return line(resumed, steps ? `Completed in ${steps}` : "Completed");
        case "incomplete":
            return line(
                resumed,
                "Stopped at its limit",
                !!event.brief && (isVisualBuild(event) ? "partial report" : "partial brief"),
                steps,
            );
        case "needs_input":
            return line(
                resumed,
                event.approval_ids?.length ? "Waiting for your approval" : "Asked Mike a question",
                steps,
            );
        case "failed":
            return { ...line(resumed, "Couldn't finish"), failed: true };
        case "cancelled":
        default:
            return line(resumed, "Stopped", steps);
    }
}

/** A disclosure row on a subagent's line, such as the task or the brief. */
function DetailDisclosureRow({
    label,
    showConnector,
    children,
}: {
    label: string;
    showConnector: boolean;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    return (
        <EventBlock dotColor="gray" showConnector={showConnector}>
            <EventDisclosureButton
                open={open}
                onToggle={() => setOpen((value) => !value)}
                label={label}
            />
            {open && children}
        </EventBlock>
    );
}

/**
 * A colour per subagent in a message, in the order they first appear. A
 * subagent Mike resumes in the same message keeps the colour it started with.
 */
export function subagentTints(events: AssistantEvent[]): Map<string, MikeIconTint> {
    const tints = new Map<string, MikeIconTint>();
    for (const event of events) {
        if (event.type !== "delegation" || tints.has(event.delegation_id)) continue;
        const earlier = event.continued_from && tints.get(event.continued_from);
        tints.set(
            event.delegation_id,
            earlier || MIKE_ICON_TINTS[tints.size % MIKE_ICON_TINTS.length],
        );
    }
    return tints;
}

/** A subagent's pill: its mark and title. Selecting it shows its details. */
function SubagentPill({
    event,
    tint,
    selected,
    detailsId,
    onSelect,
}: {
    event: DelegationEvent;
    tint: MikeIconTint;
    selected: boolean;
    detailsId: string;
    onSelect: () => void;
}) {
    const status = subagentStatus(event);
    return (
        <TabPillButtonUI
            surface="flat"
            active={selected}
            aria-controls={selected ? detailsId : undefined}
            onClick={onSelect}
            className="h-auto min-h-7 max-w-full justify-start py-1 pl-2 text-left"
        >
            {/* The pill centres this row; within it the mark lines up with
                the title's first line when a long title wraps. */}
            <span className="flex min-w-0 items-start gap-1.5">
                {/* The subagent's own mark, in its colour, turning while it
                    works. One text line tall (h-4 is text-xs's line height)
                    and centred in it. */}
                <span
                    aria-hidden="true"
                    data-slot="subagent-icon"
                    data-tint={tint}
                    className="flex h-4 shrink-0 items-center"
                >
                    <MikeIcon size={14} tint={tint} spin={!!event.isStreaming} error={status.failed} />
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                    {event.title || "Subagent"}
                    {/* Points down while this pill's details are open. Inline
                        and one line tall, so it follows the title's last word
                        and centres on that line; the svg's own margin and
                        baseline nudge are trimmed to keep it close. */}
                    <span className="inline-flex h-4 items-center align-top [&>svg]:top-0 [&>svg]:ml-0.5">
                        <EventChevron open={selected} />
                    </span>
                    {/* Visible once the pill is selected; read with the pill. */}
                    <span className="sr-only">, {status.text}</span>
                </span>
            </span>
        </TabPillButtonUI>
    );
}

/** The selected subagent's status, task, steps and brief; its pill carries the title. */
function SubagentDetails({
    id,
    event,
    showDetails,
    renderSteps,
}: {
    id: string;
    event: DelegationEvent;
    showDetails: boolean;
    renderSteps: RenderSteps;
}) {
    const status = subagentStatus(event);
    const streaming = !!event.isStreaming;
    const hasSteps = !streaming && stepCount(event) > 0;
    const hasBrief = !streaming && !!event.brief;
    const hasQuestion = !streaming && !!event.question;
    const details = showDetails ? subagentDetailsText(event) : "";
    const returned = isVisualBuild(event) ? "report" : "brief";

    return (
        <div
            id={id}
            role="region"
            aria-label={event.title || "Subagent"}
            // Flat light grey, no border or shadow: a recessed area for the
            // subagent's work rather than another raised card.
            className="mt-2 flex flex-col gap-4 rounded-xl bg-gray-100/70 px-3 py-2"
        >
            {/* The selected pill names the subagent, so the details open on
                its status, sized and coloured like the timeline's
                "Completed in N steps". */}
            <p
                className={`font-serif text-sm [overflow-wrap:anywhere] ${
                    status.failed ? "text-red-600" : "text-gray-500"
                }`}
            >
                {status.text}
            </p>
            <DetailDisclosureRow
                label="Task from Mike"
                showConnector={streaming || hasSteps || hasBrief || hasQuestion}
            >
                <p className="mt-2 whitespace-pre-wrap text-gray-600 [overflow-wrap:anywhere]">
                    {event.task}
                </p>
            </DetailDisclosureRow>
            {streaming ? (
                <EventBlock isStreaming>
                    <EventLabel>{toolCallLabel(event.activity ?? "")}</EventLabel>
                    <p className="mt-0.5 text-xs text-gray-400">
                        Steps appear when the subagent finishes.
                    </p>
                </EventBlock>
            ) : (
                renderSteps(event.events, hasBrief || hasQuestion)
            )}
            {hasBrief && (
                <DetailDisclosureRow
                    label={`Returned a ${
                        event.status === "incomplete" ? "partial " : ""
                    }${returned} to Mike`}
                    showConnector={hasQuestion}
                >
                    <ReasoningContent
                        text={event.brief!}
                        label={isVisualBuild(event) ? "Report" : "Brief"}
                    />
                </DetailDisclosureRow>
            )}
            {hasQuestion && (
                <EventBlock dotColor="gray">
                    <EventLabel>Asked Mike</EventLabel>
                    <p className="mt-0.5 whitespace-pre-wrap text-gray-800 [overflow-wrap:anywhere]">
                        {event.question}
                    </p>
                </EventBlock>
            )}
            {/* Settings > Features > Response details, at the right end like
                the details under Mike's own answer. */}
            {details && (
                <p className="self-end text-right font-serif text-sm text-gray-400 [overflow-wrap:anywhere]">
                    {details}
                </p>
            )}
        </div>
    );
}

/**
 * Subagents Mike ran in parallel: "Started …" and "… finished" are steps on
 * Mike's line, and between them, set in from that line, a row of pills holds
 * one per subagent. Selecting a pill shows that subagent's own steps below
 * the row, so a subagent's work never reads as Mike's.
 */
export function SubagentGroup({
    delegations,
    tints,
    showDetails = false,
    showConnectorAfter,
    renderSteps,
}: {
    delegations: DelegationEvent[];
    /** Each subagent's colour, from `subagentTints` over the whole message. */
    tints: Map<string, MikeIconTint>;
    /** Show each subagent's model, effort and tokens (Settings > Features). */
    showDetails?: boolean;
    /** Whether one of Mike's steps follows the group. */
    showConnectorAfter: boolean;
    renderSteps: RenderSteps;
}) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const detailsId = useId();
    const selected = delegations.find((d) => d.delegation_id === selectedId);
    const running = delegations.some((d) => d.isStreaming);
    const allDone = delegations.every((d) => d.status === "completed");
    const count = delegations.length;
    const finishedLabel = delegations.every(isVisualBuild)
        ? count === 1
            ? "Visual build finished"
            : `${count} visual builds finished`
        : count === 1
          ? "Subagent finished"
          : `${count} subagents finished`;
    return (
        <>
            {/* The pills sit in this step's content column, so Mike's line
                runs beside them to "finished" once every subagent is done. */}
            <EventBlock dotColor="green" showConnector={!running}>
                <EventLabel>{startedLabel(delegations)}</EventLabel>
                <div role="group" aria-label="Subagents" className="mt-3 flex flex-wrap gap-1.5">
                    {delegations.map((event) => (
                        <SubagentPill
                            key={event.delegation_id}
                            event={event}
                            tint={tints.get(event.delegation_id) ?? MIKE_ICON_TINTS[0]}
                            selected={event.delegation_id === selectedId}
                            detailsId={detailsId}
                            onSelect={() =>
                                setSelectedId((id) =>
                                    id === event.delegation_id ? null : event.delegation_id,
                                )
                            }
                        />
                    ))}
                </div>
                {selected && (
                    <SubagentDetails
                        key={selected.delegation_id}
                        id={detailsId}
                        event={selected}
                        showDetails={showDetails}
                        renderSteps={renderSteps}
                    />
                )}
            </EventBlock>
            {!running && (
                <EventBlock
                    dotColor={allDone ? "green" : "gray"}
                    showConnector={showConnectorAfter}
                >
                    <EventLabel>{finishedLabel}</EventLabel>
                </EventBlock>
            )}
        </>
    );
}

/** Mike's steps in a run of events, counting each subagent group as one. */
export function timelineStepCount(events: AssistantEvent[]): number {
    return events.filter(
        (event, i) => event.type !== "delegation" || events[i - 1]?.type !== "delegation",
    ).length;
}
