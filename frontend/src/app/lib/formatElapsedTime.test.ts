import { describe, expect, it } from "vitest";
import { formatElapsedTime } from "./formatElapsedTime";

describe("formatElapsedTime", () => {
    const now = Date.parse("2026-09-15T12:00:00Z");

    it.each([
        [0, "now"],
        [59_999, "now"],
        [60_000, "1m"],
        [120_000, "2m"],
        [3_599_999, "59m"],
        [3_600_000, "1h"],
        [86_399_999, "23h"],
        [86_400_000, "1d"],
        [172_800_000, "2d"],
        [-60_000, "now"],
    ])("formats an elapsed duration of %i ms as %s", (elapsed, expected) => {
        expect(
            formatElapsedTime(new Date(now - elapsed).toISOString(), now),
        ).toBe(expected);
    });

    it.each([null, undefined, "", "invalid"])(
        "omits unavailable timestamps (%s)",
        (timestamp) => {
            expect(formatElapsedTime(timestamp, now)).toBeNull();
        },
    );
});
