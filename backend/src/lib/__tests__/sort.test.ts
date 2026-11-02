import { describe, expect, it } from "vitest";
import { parseProjectSort, parseTabularReviewSort, parseWorkflowSort } from "../sort";

describe("parseTabularReviewSort", () => {
    it("supports history ordered by update time", () => {
        expect(parseTabularReviewSort({ sort_key: "updated", sort_direction: "desc" })).toEqual({
            key: "updated", direction: "desc",
        });
    });
    it("accepts a supported sort key and direction", () => {
        expect(parseTabularReviewSort({ key: "documents", direction: "asc" })).toEqual({
            key: "documents",
            direction: "asc",
        });
    });

    it("falls back to created desc for unsupported values", () => {
        expect(parseTabularReviewSort({ key: "unknown", direction: "sideways" })).toEqual({
            key: "created",
            direction: "desc",
        });
    });
});

describe("parseProjectSort", () => {
    it("accepts a supported sort key and direction", () => {
        expect(parseProjectSort({ key: "files", direction: "asc" })).toEqual({
            key: "files",
            direction: "asc",
        });
    });

    it("accepts sort_key/sort_direction as well as key/direction", () => {
        expect(
            parseProjectSort({ sort_key: "reviews", sort_direction: "asc" }),
        ).toEqual({ key: "reviews", direction: "asc" });
    });

    it("falls back to created desc for unsupported values", () => {
        expect(parseProjectSort({ key: "unknown", direction: "sideways" })).toEqual({
            key: "created",
            direction: "desc",
        });
    });
});

describe("parseWorkflowSort", () => {
    it("accepts a supported sort key and direction", () => {
        expect(parseWorkflowSort({ key: "type", direction: "asc" })).toEqual({
            key: "type",
            direction: "asc",
        });
    });

    it("accepts sort_key/sort_direction as well as key/direction", () => {
        expect(
            parseWorkflowSort({ sort_key: "name", sort_direction: "asc" }),
        ).toEqual({ key: "name", direction: "asc" });
    });

    it("falls back to created desc for unsupported values", () => {
        expect(parseWorkflowSort({ key: "unknown", direction: "sideways" })).toEqual({
            key: "created",
            direction: "desc",
        });
    });
});
