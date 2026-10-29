// How the two model calls behind a tabular cell report a provider failure.
//
// Each used to `console.error` the raw provider error, which reached Sentry
// with a stack but no name for what went wrong. Now each files one report
// under `tabular.generation_failed`, with the provider's error as the cause
// (so its class and HTTP status still arrive as provider_error and
// dependency_status), and logs that reported object so the console bridge
// does not file the same failure a second time. What the caller sees is
// unchanged: the cell call answers null, the row stream rethrows the raw
// error, and an abort is nobody's failure.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { completeText, streamChatWithTools, reportError } = vi.hoisted(() => ({
    completeText: vi.fn(),
    streamChatWithTools: vi.fn(),
    reportError: vi.fn(),
}));
vi.mock("../../../lib/llm", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/llm")>()),
    completeText,
    streamChatWithTools,
}));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("../../../lib/observability/sentry")
    >()),
    reportError,
}));
vi.mock("mammoth", () => ({
    default: { convertToHtml: async () => ({ value: "" }) },
    convertToHtml: async () => ({ value: "" }),
}));
vi.mock("../../../lib/convert", () => ({
    normalizeDocxZipPaths: async (buf: Buffer) => buf,
    docxToPdf: async (buf: Buffer) => buf,
}));

import { AppError } from "../../../lib/appError";
import { diagnosticErrorTags } from "../../../lib/observability/sentryPrivacy";
import { queryTabularAllColumns, queryTabularCell } from "../tabular.extract";

/** The AI SDK's provider failure, as the privacy boundary classifies it. */
function providerError(): Error {
    return Object.assign(new Error("401 invalid x-api-key sk-abc"), {
        name: "AI_APICallError",
        statusCode: 401,
    });
}

const COLUMNS = [{ index: 0, name: "A", prompt: "a" }];

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    consoleError.mockRestore();
});

describe("queryTabularCell", () => {
    it("answers null and reports the provider failure once, under its kind, with the cause", async () => {
        const cause = providerError();
        completeText.mockRejectedValue(cause);

        const result = await queryTabularCell("m", "Contract.pdf", "text", "p");

        expect(result).toBeNull();
        expect(reportError).toHaveBeenCalledTimes(1);
        const [reported] = reportError.mock.calls[0];
        expect(reported).toBeInstanceOf(AppError);
        expect(reported.kind).toBe("tabular.generation_failed");
        expect(reported.cause).toBe(cause);
        expect(diagnosticErrorTags(reported)).toEqual({
            error_kind: "tabular.generation_failed",
            provider_error: "api_call",
            dependency_status: 401,
        });
        // The log carries the reported object, not the raw error: the console
        // bridge recognises it and files nothing.
        expect(consoleError).toHaveBeenCalledWith(
            "[queryTabularCell] completion failed",
            reported,
        );
    });

    it("reports nothing when the model answers", async () => {
        completeText.mockResolvedValue(
            '{"summary":"NY","flag":"green","reasoning":""}',
        );
        await expect(
            queryTabularCell("m", "Contract.pdf", "text", "p"),
        ).resolves.toMatchObject({ summary: "NY" });
        expect(reportError).not.toHaveBeenCalled();
    });
});

describe("queryTabularAllColumns", () => {
    it("rethrows the raw provider error and reports it once under its kind", async () => {
        const cause = providerError();
        streamChatWithTools.mockRejectedValue(cause);

        // The raw error is what the row orchestrator classifies for the grid
        // (an invalid key becomes an actionable frame), so the wrapper is for
        // the report only.
        await expect(
            queryTabularAllColumns("m", "Contract.pdf", "text", COLUMNS, async () => {}),
        ).rejects.toBe(cause);

        expect(reportError).toHaveBeenCalledTimes(1);
        const [reported] = reportError.mock.calls[0];
        expect(reported).toBeInstanceOf(AppError);
        expect(reported.kind).toBe("tabular.generation_failed");
        expect(reported.cause).toBe(cause);
        expect(consoleError).toHaveBeenCalledWith(
            "[queryTabularAllColumns] stream failed",
            reported,
        );
    });

    it("leaves reporting to the queue runner when requested", async () => {
        const cause = providerError();
        streamChatWithTools.mockRejectedValue(cause);
        for (let attempt = 0; attempt < 3; attempt++) {
            await expect(queryTabularAllColumns("m", "Contract.pdf", "text", COLUMNS, async () => {}, undefined, undefined, undefined, false)).rejects.toBe(cause);
        }
        expect(reportError).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });

    it("treats a stop as the caller's, not a failure: rethrown, never reported", async () => {
        const controller = new AbortController();
        const abort = new Error("aborted");
        streamChatWithTools.mockImplementation(async () => {
            controller.abort();
            throw abort;
        });

        await expect(
            queryTabularAllColumns(
                "m",
                "Contract.pdf",
                "text",
                COLUMNS,
                async () => {},
                {},
                controller.signal,
            ),
        ).rejects.toBe(abort);
        expect(reportError).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });
});
