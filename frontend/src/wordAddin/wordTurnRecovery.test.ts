/**
 * What Retry may do after a Word turn failed. A wrong answer here either
 * POSTs a second turn the server is already running (edits applied twice)
 * or hides a Retry that would plainly have worked.
 */
import { describe, expect, it } from "vitest";
import { failedTurnRecovery } from "../../../word-addin/src/taskpane/lib/wordTurnRecovery";

const base = {
    wasSend: true,
    requestPosted: true,
    turnIsTerminal: false,
    chatId: null,
    turnId: null,
    status: null,
} as const;

describe("failedTurnRecovery", () => {
    it("re-attaches to a known, unfinished server turn instead of re-posting", () => {
        expect(
            failedTurnRecovery({ ...base, chatId: "chat-1", turnId: "turn-1" }),
        ).toEqual({ kind: "resume", chatId: "chat-1", turnId: "turn-1" });
    });

    it.each([null, 500, 503])(
        "offers nothing when a posted turn's fate is unknown (status %s)",
        (status) => {
            expect(failedTurnRecovery({ ...base, status })).toEqual({
                kind: "uncertain",
            });
        },
    );

    it("re-sends when the server refused the turn with a 4xx", () => {
        expect(failedTurnRecovery({ ...base, status: 429 })).toEqual({
            kind: "resend",
        });
    });

    it("re-sends after a terminal error frame, even with a known turn id", () => {
        expect(
            failedTurnRecovery({
                ...base,
                turnIsTerminal: true,
                chatId: "chat-1",
                turnId: "turn-1",
            }),
        ).toEqual({ kind: "resend" });
    });

    it("re-sends when the request never left the pane", () => {
        expect(failedTurnRecovery({ ...base, requestPosted: false })).toEqual({
            kind: "resend",
        });
    });

    it("has nothing to offer for a failed resume without a turn to rejoin", () => {
        expect(
            failedTurnRecovery({ ...base, wasSend: false, requestPosted: false }),
        ).toEqual({ kind: "none" });
    });
});
