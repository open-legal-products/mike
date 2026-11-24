import type { SourceDocumentType } from "@mike/contracts";
import type { AssistantEvent } from "@/app/components/shared/types";

export type CitationsRecordedEvent = Extract<
    AssistantEvent,
    { type: "citations_recorded" }
>;

/** The step a citations_recorded_start frame opens, until its result arrives. */
export function recordingCitationsEvent(): CitationsRecordedEvent {
    return {
        type: "citations_recorded",
        refs: [],
        sources: [],
        quotes_not_found: 0,
        rejected: 0,
        isStreaming: true,
    };
}

const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

/** A citations_recorded frame as an event, keeping only well-formed fields. */
export function citationsRecordedEvent(
    data: Record<string, unknown>,
): CitationsRecordedEvent {
    return {
        type: "citations_recorded",
        refs: Array.isArray(data.refs)
            ? data.refs.filter((ref): ref is number => typeof ref === "number")
            : [],
        sources: Array.isArray(data.sources)
            ? data.sources.flatMap((raw: unknown) => {
                  const source = raw as Record<string, unknown> | null;
                  return source &&
                      typeof source.name === "string" &&
                      typeof source.type === "string" &&
                      typeof source.ref === "number"
                      ? [
                            {
                                name: source.name,
                                type: source.type as SourceDocumentType,
                                ref: source.ref,
                            },
                        ]
                      : [];
              })
            : [],
        quotes_not_found: count(data.quotes_not_found),
        rejected: count(data.rejected),
    };
}

/** Whether `event` is the citations step still waiting for its result. */
export const isRecordingCitations = (event: AssistantEvent) =>
    event.type === "citations_recorded" && !!event.isStreaming;

/** A numeric ref belongs to the latest top-level call that recorded it.
 * Nested runs number their own refs; their events never enter this map. */
export function currentCitationSteps(events: readonly AssistantEvent[]) {
    const owners = new Map<number, CitationsRecordedEvent>();
    for (const event of events) {
        if (event.type !== "citations_recorded") continue;
        if (event.isStreaming) return new Map<number, CitationsRecordedEvent>();
        for (const ref of event.refs) owners.set(ref, event);
    }
    return owners;
}
