import { describe, expect, it } from "vitest";

import {
    MAX_COMMITTEE_MEMBERS,
    MAX_USER_COMMITTEES,
    isUserCommitteeId,
    normalizeUserCommittees,
    validateUserCommittees,
} from "../userCommittees";

const VALID = {
    id: "user-committee/panel",
    label: "Panel",
    members: ["claude-opus-5", "gemini-3.5-flash"],
    chair: "gpt-5.5",
};

describe("isUserCommitteeId", () => {
    it("recognises the user-committee namespace only", () => {
        expect(isUserCommitteeId("user-committee/panel")).toBe(true);
        expect(isUserCommitteeId("claude-opus-5")).toBe(false);
        expect(isUserCommitteeId(null)).toBe(false);
    });
});

describe("normalizeUserCommittees", () => {
    it("reads a stored array", () => {
        expect(normalizeUserCommittees([VALID])).toEqual([
            { ...VALID, strategy: "synthesize" },
        ]);
    });

    it("parses a JSON string column", () => {
        expect(normalizeUserCommittees(JSON.stringify([VALID]))).toHaveLength(
            1,
        );
    });

    it("drops malformed entries instead of throwing", () => {
        expect(
            normalizeUserCommittees([
                VALID,
                null,
                "nonsense",
                { ...VALID, id: "not-namespaced" },
                { ...VALID, members: ["only-one"] },
                { ...VALID, chair: "" },
            ]),
        ).toHaveLength(1);
    });

    it("returns nothing for unusable input", () => {
        expect(normalizeUserCommittees("{not json")).toEqual([]);
        expect(normalizeUserCommittees(undefined)).toEqual([]);
        expect(normalizeUserCommittees({})).toEqual([]);
    });

    it("caps the number of committees and members", () => {
        const many = Array.from({ length: MAX_USER_COMMITTEES + 3 }, (_, i) => ({
            ...VALID,
            id: `user-committee/p${i}`,
        }));
        expect(normalizeUserCommittees(many)).toHaveLength(MAX_USER_COMMITTEES);

        const wide = normalizeUserCommittees([
            {
                ...VALID,
                members: Array.from(
                    { length: MAX_COMMITTEE_MEMBERS + 3 },
                    (_, i) => `claude-opus-5-${i}`,
                ),
            },
        ]);
        expect(wide[0].members).toHaveLength(MAX_COMMITTEE_MEMBERS);
    });
});

describe("validateUserCommittees", () => {
    it("accepts a well-formed committee", () => {
        expect(validateUserCommittees([VALID])).toEqual([
            { ...VALID, strategy: "synthesize" },
        ]);
    });

    it("requires an array", () => {
        expect(() => validateUserCommittees("nope")).toThrow(
            /must be an array/,
        );
    });

    it("rejects more committees than allowed", () => {
        const many = Array.from({ length: MAX_USER_COMMITTEES + 1 }, (_, i) => ({
            ...VALID,
            id: `user-committee/p${i}`,
        }));
        expect(() => validateUserCommittees(many)).toThrow(
            /up to 8 committees/,
        );
    });

    it("rejects a committee that would be silently dropped", () => {
        expect(() =>
            validateUserCommittees([{ ...VALID, members: ["claude-opus-5"] }]),
        ).toThrow(/needs a name, a chair, and between 2 and 8 members/);
    });

    it("rejects duplicate ids", () => {
        expect(() => validateUserCommittees([VALID, VALID])).toThrow(
            /already in use/,
        );
    });

    it("rejects a repeated member", () => {
        expect(() =>
            validateUserCommittees([
                { ...VALID, members: ["claude-opus-5", "claude-opus-5"] },
            ]),
        ).toThrow(/same member more than once/);
    });

    it("rejects a nested committee", () => {
        expect(() =>
            validateUserCommittees([
                {
                    ...VALID,
                    members: ["user-committee/other", "claude-opus-5"],
                },
            ]),
        ).toThrow(/cannot contain another committee/);
    });

    it("rejects an unknown member model", () => {
        expect(() =>
            validateUserCommittees([
                { ...VALID, members: ["claude-opus-5", "not-a-model"] },
            ]),
        ).toThrow(/Unknown committee model: not-a-model/);
    });

    it("rejects an unknown chair", () => {
        expect(() =>
            validateUserCommittees([{ ...VALID, chair: "not-a-model" }]),
        ).toThrow(/Unknown committee model: not-a-model/);
    });

    it("rejects an over-long name", () => {
        expect(() =>
            validateUserCommittees([{ ...VALID, label: "x".repeat(81) }]),
        ).toThrow(/80 characters or fewer/);
    });
});
