import { describe, expect, it } from "vitest";
import {
    ACCOUNT_MODEL_PROVIDERS,
    type AccountModelProvider,
    isSafeAccountModelId,
} from "./accountModelIds";
import { normalizeCustomBaseUrl } from "./cloudProviderSettings";
import sharedCases from "../../../../packages/byok-validation/cases.json";

// These cases are shared with the backend's authoritative rules
// (backend/src/lib/llm/models.ts). Both suites read the same file so the
// browser copies cannot drift apart silently. See
// packages/byok-validation/README.md.
type AccountModelIdCase = {
    id: string;
    providers?: AccountModelProvider[];
    valid: boolean;
    why: string;
};

type CustomBaseUrlCase = {
    input: string;
    expected: string | null;
    why: string;
    /** Where the browser copy deliberately differs from the backend. */
    browser?: { expected: string | null; why: string };
};

describe("isSafeAccountModelId (shared cases)", () => {
    const cases = sharedCases.accountModelIds as AccountModelIdCase[];

    it("applies to the same account-specific providers", () => {
        expect([...ACCOUNT_MODEL_PROVIDERS]).toEqual(
            sharedCases.accountModelProviders,
        );
    });

    for (const testCase of cases) {
        for (const provider of testCase.providers ?? ACCOUNT_MODEL_PROVIDERS) {
            it(`${provider}: ${JSON.stringify(testCase.id)} (${testCase.why})`, () => {
                expect(isSafeAccountModelId(provider, testCase.id)).toBe(
                    testCase.valid,
                );
            });
        }
    }
});

describe("normalizeCustomBaseUrl (shared cases)", () => {
    const cases = sharedCases.customBaseUrls as CustomBaseUrlCase[];

    // The browser list of private ranges is intentionally shorter than the
    // backend's, so it may let through a URL the backend then rejects — but
    // never the reverse, which would block a URL the server accepts.
    it("only ever differs from the backend by accepting what it rejects", () => {
        for (const testCase of cases.filter((item) => item.browser)) {
            expect(testCase.expected, testCase.input).toBeNull();
        }
    });

    for (const testCase of cases) {
        const expected = testCase.browser
            ? testCase.browser.expected
            : testCase.expected;
        const why = testCase.browser
            ? `backend rejects; browser accepts: ${testCase.browser.why}`
            : testCase.why;
        it(`${JSON.stringify(testCase.input)} (${why})`, () => {
            expect(normalizeCustomBaseUrl(testCase.input)).toBe(expected);
        });
    }
});
