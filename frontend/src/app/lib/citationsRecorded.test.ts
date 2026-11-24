import { describe, expect, it } from "vitest";
import {
    citationsRecordedEvent,
    currentCitationSteps,
    isRecordingCitations,
    recordingCitationsEvent,
} from "./citationsRecorded";

describe("citationsRecordedEvent", () => {
    it("keeps a well-formed frame's fields", () => {
        const frame = {
            type: "citations_recorded",
            refs: [1, 2],
            sources: [{ name: "Lease.pdf", type: "pdf", ref: 1 }],
            quotes_not_found: 1,
            rejected: 2,
        };
        expect(citationsRecordedEvent(frame)).toEqual(frame);
    });

    it("drops malformed refs and sources, and zeroes malformed counts", () => {
        expect(
            citationsRecordedEvent({
                refs: [3, "4"],
                sources: [{ name: "Act", type: "legislation", ref: 3 }, { name: "x" }, null],
                quotes_not_found: "1",
            }),
        ).toEqual({
            type: "citations_recorded",
            refs: [3],
            sources: [{ name: "Act", type: "legislation", ref: 3 }],
            quotes_not_found: 0,
            rejected: 0,
        });
    });

    it("tells the step in progress from a finished one", () => {
        expect(isRecordingCitations(recordingCitationsEvent())).toBe(true);
        expect(isRecordingCitations(citationsRecordedEvent({}))).toBe(false);
    });
});

it("withholds source actions while a replacement call is in flight", () => {
    const first = citationsRecordedEvent({ refs: [1, 2] });
    const replacement = citationsRecordedEvent({ refs: [1] });
    expect(currentCitationSteps([first, recordingCitationsEvent()]).size).toBe(0);

    const owners = currentCitationSteps([first, { type: "content", text: "See [1]" }, replacement]);
    expect(owners.get(1)).toBe(replacement);
    expect(owners.get(2)).toBe(first);
});

it("removes source actions for withdrawn refs until they are recorded again", () => {
    const first = citationsRecordedEvent({ refs: [1, 2] });
    const removal = citationsRecordedEvent({ removed_refs: [1, "2"] });
    expect(removal).toMatchObject({ removed_refs: [1] });
    const owners = currentCitationSteps([first, removal]);
    expect(owners.has(1)).toBe(false);
    expect(owners.get(2)).toBe(first);
    const reuse = citationsRecordedEvent({ refs: [1] });
    expect(currentCitationSteps([first, removal, reuse]).get(1)).toBe(reuse);
});
