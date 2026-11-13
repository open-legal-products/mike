import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
const { streamChatWithTools } = vi.hoisted(() => ({ streamChatWithTools: vi.fn() }));
vi.mock("../../../lib/llm", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/llm")>()), streamChatWithTools,
}));
vi.mock("../tabular.rows", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tabular.rows")>()),
    loadRowDocumentText: async () => "PRIVATE_DOCUMENT_TEXT",
}));
import { resetSentryForTests, scrubEvent } from "../../../lib/observability/sentry";
import { privacyBoundaryIntegration } from "../../../lib/observability/sentryPrivacy";
import { toProviderStreamError } from "../../../lib/llm/providerErrors";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { streamTabularGenerateSync } from "../tabular.generateStream";

let events: Sentry.Event[];
beforeEach(() => {
    events = [];
    streamChatWithTools.mockReset();
    resetSentryForTests("official", { initialized: true });
    Sentry.init({
        dsn: "https://test@sentry.invalid/1", defaultIntegrations: false,
        integrations: [Sentry.linkedErrorsIntegration(), privacyBoundaryIntegration()], beforeSend: scrubEvent,
        transport: () => ({ send: async envelope => {
            for (const [header, payload] of envelope[1]) if (header.type === "event") events.push(payload as Sentry.Event);
            return { statusCode: 200 };
        }, flush: async () => true }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => { await Sentry.close(); resetSentryForTests(); vi.restoreAllMocks(); });

async function generateTwoRows() {
    await Sentry.withScope(async scope => {
        scope.setTag("operation", "tabular.run");
        await streamTabularGenerateSync({
            write: () => true, db: tableDb({ tabular_cells: [] }).db,
            reviewId: "rev-1", columns: [{ index: 0, name: "A", prompt: "a" }],
            rows: ["row-1", "row-2"].map((id, sort_index) => ({
                id, review_id: "rev-1", label: id, row_type: "document", folder_id: null,
                library_folder_id: null, document_id: `doc-${id}`, sort_index, source_document_ids: [`doc-${id}`],
            })),
            cellMap: new Map(), model: "m", apiKeys: {}, generationId: "gen-1", abortSignal: new AbortController().signal,
        });
    });
    await Sentry.flush(2000);
}

it("keeps distinct unexpected failures with their original types and source frames", async () => {
    streamChatWithTools.mockRejectedValueOnce(new TypeError("PRIVATE_ADAPTER_FAILURE"))
        .mockRejectedValueOnce(new RangeError("PRIVATE_SERIALIZATION_FAILURE"));
    await generateTwoRows();
    expect(events).toHaveLength(2);
    for (const [index, type] of ["TypeError", "RangeError"].entries()) {
        expect(events[index].tags).toMatchObject({ operation: "tabular.run", error_kind: "tabular.generation_failed" });
        const original = events[index].exception?.values?.find(value => value.type === type);
        expect(original?.stacktrace?.frames?.some(frame => frame.filename?.endsWith("tabular.generateStream.envelopes.test.ts"))).toBe(true);
    }
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
});

it.each([
    [401, "user", 0, undefined],
    [401, "deployment", 1, "error"],
    [402, "user", 1, "warning"],
    [503, "deployment", 1, "warning"],
] as const)("retains the repeat policy for identified provider conditions (%s, %s)", async (status, keySource, count, level) => {
    streamChatWithTools.mockImplementation(async () => {
        throw toProviderStreamError(Object.assign(new Error("PRIVATE_PROVIDER_BODY"), {
            name: "AI_APICallError", statusCode: status, responseBody: "PRIVATE_BODY",
        }), { label: "Anthropic", modelId: "m", provider: "claude", keySource });
    });
    await generateTwoRows();
    expect(events).toHaveLength(count);
    if (count) expect(events[0].level).toBe(level);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
});
