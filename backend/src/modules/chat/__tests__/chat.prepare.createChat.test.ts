import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(() => null) }));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reportError,
}));

// The model selection reads several settings tables; what matters here is the
// insert that follows it, so the selection is a fixed answer.
vi.mock("../../user/user.service", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveUserChatSelection: vi.fn(async () => ({
        ok: true,
        modelSettings: { api_keys: {}, last_selected_chat_model: null, last_selected_reasoning_level: null },
        selectedModel: "claude-opus-5",
        selectedReasoningLevel: null,
    })),
}));

import { prepareChatStream } from "../chat.prepare";

const turn = {
    userId: "u1",
    userEmail: "u1@example.com",
    messages: [{ role: "user" as const, content: "Summarise this" }],
    chatId: null,
    inputMessageId: null,
    projectIdProvided: false,
    projectId: null,
    askInputsResponse: null,
    requestedModel: undefined,
    requestedReasoning: undefined,
};

beforeEach(() => vi.clearAllMocks());

// The route answers 500 from this result without throwing, so nothing else
// reports the failed insert: it is reported here, under its kind, with the
// database's error as the cause, and the same object is what gets logged.
describe("prepareChatStream when the chat row cannot be created", () => {
    it("reports the failed insert once and answers 500", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const dbError = { code: "23503", message: "violates foreign key" };
        const fake = scriptedDb([{ table: "chats", op: "insert", error: dbError }]);

        await expect(prepareChatStream(fake.db, turn)).resolves.toMatchObject({
            ok: false,
            status: 500,
            detail: "Failed to create chat",
        });

        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "db.query_failed", cause: dbError }),
            { tags: { component: "chat-stream" } },
        );
        const [reported] = reportError.mock.calls[0] as unknown[];
        expect(errorSpy).toHaveBeenCalledWith("[chat/stream] failed to create chat", reported);
        errorSpy.mockRestore();
    });
});
