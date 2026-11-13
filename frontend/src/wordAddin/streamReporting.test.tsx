/// <reference types="office-runtime" />
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { clearToasts, privacyBoundaryIntegration } from "@mike/client";

const mocks = vi.hoisted(() => ({ stream: vi.fn(), resume: vi.fn() }));
vi.mock("../../../word-addin/src/taskpane/api/mikeApi", async () => ({
    readSSE: (await import("../../../word-addin/src/taskpane/api/client")).readSSE,
    streamWordChat: mocks.stream, streamWordChatTurn: mocks.resume,
    postWordChatToolResult: vi.fn(), stopWordChatTurn: vi.fn(),
}));
vi.mock("../../../word-addin/src/taskpane/hooks/useWordDoc", () => ({ useWordDoc: () => ({ readDocumentMarkdown: async () => "" }) }));
vi.mock("../../../word-addin/src/taskpane/lib/localWordChats", () => ({ saveLocalWordMessage: vi.fn(), setLocalWordChatActiveTurn: vi.fn() }));
vi.mock("../../../word-addin/src/taskpane/lib/wordDocumentIdentity", () => ({ readCurrentDocumentName: () => "PrivateDocument.docx" }));

import { useWordAssistantChat } from "../../../word-addin/src/taskpane/hooks/useWordAssistantChat";
import { resumeAssistant } from "../../../word-addin/src/taskpane/api/stream";
import { MikeApiError } from "../../../word-addin/src/taskpane/api/client";
import { isReported, scrubEvent } from "../../../word-addin/src/taskpane/lib/errorReporting";

const requestId = "11111111-1111-4111-8111-111111111111";
let events: Sentry.Event[];
beforeEach(() => {
    mocks.stream.mockReset(); mocks.resume.mockReset(); clearToasts();
    events = [];
    Sentry.init({
        dsn: "https://test@sentry.invalid/1", defaultIntegrations: false,
        integrations: [privacyBoundaryIntegration()], beforeSend: scrubEvent,
        transport: () => ({ send: async envelope => {
            for (const [header, payload] of envelope[1]) if (header.type === "event") events.push(payload as Sentry.Event);
            return { statusCode: 200 };
        }, flush: async () => true }),
    });
});
afterEach(async () => { clearToasts(); await Sentry.close(); });

function response(status: number, owner?: string) {
    return Response.json({ detail: "PRIVATE_BACKEND_DETAIL", code: "upstream_unavailable", request_id: requestId, reporting_owner: owner }, { status });
}

it.each([[500, "backend"], [503, "backend"], [500, undefined], [503, undefined]] as const)("honors ownership through the Word POST parser, hook and notifier for %i (%s)", async (status, owner) => {
    mocks.stream.mockResolvedValueOnce(response(status, owner));
    const { result } = renderHook(() => useWordAssistantChat({
        sessionKey: 1, chatId: "chat-1", initialMessages: [],
        onChatIdChange: vi.fn(), onChatStarted: vi.fn(), wordDocumentId: "doc-1",
        wordChatStorage: "cloud", wordChatOwnerId: "user-1", editApplyMode: "direct",
        editController: { applyToolEdits: vi.fn().mockResolvedValue([]), processLiveRedlines: vi.fn(), markIncompleteRedlines: vi.fn(), waitForMessageEdits: vi.fn().mockResolvedValue(undefined) },
    }));
    await act(async () => { await result.current.handleChat({ content: "Private prompt", model: "gpt-5.4", reasoning: "none" }); });
    expect(result.current.isResponseLoading).toBe(false);
    expect(await Sentry.flush(2000)).toBe(true);
    expect(events).toHaveLength(owner === "backend" ? 0 : 1);
    if (owner !== "backend") expect(events[0]?.tags).toMatchObject({ operation: "word_chat.turn", http_status: status, http_method: "POST", request_id: requestId });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_BACKEND_DETAIL");
});

it.each(["backend", undefined, "proxy"])("preserves resume metadata and only trusts explicit backend ownership (%s)", async owner => {
    mocks.resume.mockResolvedValueOnce(response(503, owner));
    const error = await resumeAssistant({ chatId: "chat-1", turnId: "turn-1", documentId: "doc-1" }, vi.fn()).catch(error => error);
    expect(error).toBeInstanceOf(MikeApiError);
    expect(error).toMatchObject({ status: 503, requestId, code: "upstream_unavailable", reportingOwner: owner === "backend" ? "backend" : undefined });
    expect(isReported(error)).toBe(true);
    expect(await Sentry.flush(2000)).toBe(true);
    expect(events).toHaveLength(owner === "backend" ? 0 : 1);
    if (owner !== "backend") expect(events[0]?.tags).toMatchObject({ operation: "word_chat.turn", http_status: 503, http_method: "GET", request_id: requestId });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_BACKEND_DETAIL");
});
