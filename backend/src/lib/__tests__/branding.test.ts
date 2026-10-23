import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appDomain, appName, assistantPersona } from "../branding";

const KEYS = ["APP_NAME", "APP_ASSISTANT_PERSONA", "APP_DOMAIN"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

// Each test starts from an unset environment, whatever the process was
// started with, and leaves it as it found it.
beforeEach(() => {
    for (const key of KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

describe("branding", () => {
    it("defaults to Mike and the legal persona", () => {
        expect(appName()).toBe("Mike");
        expect(assistantPersona()).toBe(
            "an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.",
        );
        expect(appDomain()).toBe("legal");
    });

    it("reads the environment", () => {
        process.env.APP_NAME = "Acme Assist";
        process.env.APP_ASSISTANT_PERSONA = "an AI assistant for tax professionals.";
        process.env.APP_DOMAIN = "tax";
        expect(appName()).toBe("Acme Assist");
        expect(assistantPersona()).toBe("an AI assistant for tax professionals.");
        expect(appDomain()).toBe("tax");
    });

    it("falls back on empty or whitespace values", () => {
        process.env.APP_NAME = "   ";
        process.env.APP_ASSISTANT_PERSONA = "";
        process.env.APP_DOMAIN = "";
        expect(appName()).toBe("Mike");
        expect(assistantPersona()).toBe(
            "an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.",
        );
        expect(appDomain()).toBe("legal");
    });

    it("trims surrounding whitespace", () => {
        process.env.APP_NAME = "  Acme Assist  ";
        expect(appName()).toBe("Acme Assist");
    });
});
