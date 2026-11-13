// The PostgreSQL queue retries whatever a handler throws unless it is a
// NonRetryableJobError. These are the failures that are the same on every
// attempt, so the handler must say so.

import { describe, it, expect, vi, beforeEach } from "vitest";

const runExtractionJob = vi.hoisted(() => vi.fn());
vi.mock("../tabular.extraction", () => ({
    runExtractionJob,
    markExtractionFailed: vi.fn(),
}));
vi.mock("../../../lib/queue/runProgress", () => ({
    publishCellUpdate: vi.fn(),
}));

import { handleExtractionExtract } from "../tabular.extractionJobs";
import { NonRetryableJobError } from "../../../lib/dbq/runner";
import { ExtractionParseError } from "../../../lib/extraction/failure";
import {
    ExtractionBusyError,
    ExtractionLimitError,
} from "../../../lib/extraction/limits";
import type { DbJob } from "../../../lib/dbq/types";
import { AppError } from "../../../lib/appError";
import { toProviderStreamError } from "../../../lib/llm/providerErrors";

/** The error runExtractionJob ends with when the provider failed the row. */
function providerFailure(statusCode: number, keySource: "user" | "deployment"): Error {
    const answer = Object.assign(new Error(`${statusCode} from provider`), { name: "AI_APICallError", statusCode, responseBody: "" });
    const cause = toProviderStreamError(answer, { label: "Anthropic", modelId: "m", keySource, provider: "claude" });
    return new AppError("tabular.generation_failed", "incomplete extraction", { cause });
}

const job = { payload: { reviewId: "rev-1", rowId: "row-1" } } as unknown as DbJob;

/** The handler's outcome when the extraction job fails with `failure`. */
async function thrownFor(failure: Error): Promise<unknown> {
    runExtractionJob.mockImplementation(async () => {
        throw failure;
    });
    try {
        await handleExtractionExtract({} as never, job);
    } catch (error) {
        return error;
    }
    return undefined;
}

beforeEach(() => {
    runExtractionJob.mockReset();
});

describe("handleExtractionExtract", () => {
    it("ends retries for an unreadable source document, as a warning that keeps the parser's error", async () => {
        const parse = new ExtractionParseError(
            "extraction.parse_failed",
            "unreadable docx",
        );
        const error = await thrownFor(parse);

        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as NonRetryableJobError).message).toBe(
            "document_text_unreadable",
        );
        expect((error as NonRetryableJobError).cause).toBe(parse);
        expect((error as NonRetryableJobError).reportLevel).toBe("warning");
    });

    it("ends retries for a source document over the extraction limits", async () => {
        const limit = new ExtractionLimitError("too many pages");
        const error = await thrownFor(limit);

        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as NonRetryableJobError).message).toBe("document_too_large");
        expect((error as NonRetryableJobError).cause).toBe(limit);
    });

    it.each([
        ["parser capacity", new ExtractionBusyError()],
        ["an incomplete extraction", new Error("incomplete extraction")],
    ])("leaves %s retryable", async (_name, transient) => {
        expect(await thrownFor(transient)).toBe(transient);
    });

    // Even the user's own rejected key keeps its warning here: this queue runs
    // without Redis, so no error frame reaches the grid to name the remedy.
    it.each([
        ["the user's own key", 401, "user", "warning"],
        ["the user's out-of-credits account", 402, "user", "warning"],
        ["the deployment's key", 401, "deployment", "error"],
    ] as const)("ends retries when the provider rejects %s, at the chat engine's level", async (_name, status, keySource, level) => {
        const refusal = providerFailure(status, keySource);
        const error = await thrownFor(refusal);

        expect(error).toBeInstanceOf(NonRetryableJobError);
        expect((error as NonRetryableJobError).cause).toBe(refusal);
        expect((error as NonRetryableJobError).reportLevel).toBe(level);
    });

    it.each([503, 429])("leaves a provider %i retryable", async (status) => {
        const transient = providerFailure(status, "user");
        expect(await thrownFor(transient)).toBe(transient);
    });
});
