import { describe, expect, it } from "vitest";
import type { Message } from "../shared/types";
import { createProjectMutationSignature } from "./projectMutationSignature";

describe("project mutation tracking", () => {
    it("reads each completed transcript once while a new response streams", () => {
        let reads = 0;
        const messages = Array.from({length: 1000}, (_, i) => ({role: "assistant", get events() {reads++; return [{type: "content", text: String(i)}];}} as Message));
        const signature = createProjectMutationSignature();
        for (let tick = 0; tick < 100; tick++) expect(signature([...messages, {role: "assistant", events: [{type: "content", text: "live".repeat(tick)}]} as Message])).toBe("");
        expect(reads).toBe(1000);
    });
    it("reports completed changes, deduplicates and handles history replacement", () => {
        const signature = createProjectMutationSignature();
        const created = {role: "assistant", events: [{type: "doc_created", document_id: "a", filename: "A", isStreaming: true}]} as Message;
        expect(signature([created])).toBe("");
        const done = {...created, events: [{...created.events![0], isStreaming: false}]} as Message;
        expect(signature([done, done])).toBe("created:a::A");
        expect(signature([])).toBe("");
    });
});
