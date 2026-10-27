import { describe, expect, it } from "vitest";
import { diagnosticEvent } from "./sentryPrivacy";

describe("application diagnostic labels", () => {
    it("accepts a new operation, kind, component and stage without registration", () => {
        const tags = { operation: "new_feature.run", error_kind: "new_feature.failed", component: "new-worker", stage: "new-step", job_kind: "new_feature.job" };
        const event = diagnosticEvent({ tags, breadcrumbs: [{ category: "mike.stage", message: "new-step" }] });
        expect(event.tags).toEqual(tags);
        expect(event.message).toContain("new_feature.failed");
        expect(event.breadcrumbs).toEqual([{ category: "mike.stage", message: "new-step" }]);
    });
    it("still drops unknown fields and malformed labels", () => {
        expect(diagnosticEvent({ tags: { operation: "Jane Doe's file.pdf", filename: "private.pdf" }, request: { data: "private" } }).tags).toEqual({});
    });
});
