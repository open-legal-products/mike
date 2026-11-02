import { describe, expect, it } from "vitest";
import {
    ACCOUNT_MODEL_PREFIXES,
    type AccountModelPrefix,
    isSafeAccountModelId,
} from "../llm/models";
import { normalizeCustomBaseUrl } from "../llm/cloudProviders";
import sharedCases from "../../../../packages/byok-validation/cases.json";

// These cases are shared with the browser copies of the BYOK validation rules
// (frontend/src/app/lib). Both suites read the same file so the copies cannot
// drift apart silently. See packages/byok-validation/README.md.
type AccountModelIdCase = {
    id: string;
    providers?: AccountModelPrefix[];
    valid: boolean;
    why: string;
};

type CustomBaseUrlCase = {
    input: string;
    expected: string | null;
    why: string;
    browser?: { expected: string | null; why: string };
};

describe("isSafeAccountModelId (shared cases)", () => {
    const cases = sharedCases.accountModelIds as AccountModelIdCase[];

    it("applies to the same account-specific providers", () => {
        expect([...ACCOUNT_MODEL_PREFIXES]).toEqual(
            sharedCases.accountModelProviders,
        );
    });

    for (const testCase of cases) {
        for (const provider of testCase.providers ?? ACCOUNT_MODEL_PREFIXES) {
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

    // `browser` only describes the inline-feedback copy; the backend is
    // held to `expected` for every case.
    for (const testCase of cases) {
        it(`${JSON.stringify(testCase.input)} (${testCase.why})`, () => {
            expect(normalizeCustomBaseUrl(testCase.input)).toBe(
                testCase.expected,
            );
        });
    }
});
