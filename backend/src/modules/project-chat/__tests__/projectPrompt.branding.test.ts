import { afterEach, describe, expect, it } from "vitest";
import { projectSystemPromptExtra } from "../projectChat.service";

afterEach(() => {
    delete process.env.APP_DOMAIN;
});

describe("project chat prompt", () => {
    it("describes legal documents by default", () => {
        expect(projectSystemPromptExtra()).toContain(
            "a collection of legal documents the user has organised for a single matter.",
        );
    });

    it("describes documents of APP_DOMAIN", () => {
        process.env.APP_DOMAIN = "tax";
        expect(projectSystemPromptExtra()).toContain(
            "a collection of tax documents the user has organised for a single matter.",
        );
    });
});
