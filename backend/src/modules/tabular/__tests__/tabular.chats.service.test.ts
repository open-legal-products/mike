// Unit tests for the review-chat services: the CRUD endpoints' branching, and
// the prepare step that runs before POST /:reviewId/chat writes its first SSE
// byte. The prepare step is where the interesting invariants live — a chat id
// from another review must not be adoptable, and the user's turn must not be
// stored before the chat row exists.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ensureReviewAccess = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/access", () => ({ ensureReviewAccess }));

const {
    getUserModelSettings,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
} = vi.hoisted(() => ({
    getUserModelSettings: vi.fn(),
    persistLastSelectedChatModel: vi.fn(),
    persistLastSelectedReasoningLevel: vi.fn(),
}));
vi.mock("../../user/user.settings", () => ({
    getUserModelSettings,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
}));

const { resolveEffectiveChatModel } = vi.hoisted(() => ({
    resolveEffectiveChatModel: vi.fn(),
}));
vi.mock("../../../lib/modelSelection", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/modelSelection")>()),
    resolveEffectiveChatModel,
}));

const generateChatTitle = vi.hoisted(() => vi.fn());
vi.mock("../tabular.extract", () => ({ generateChatTitle }));

const loadReviewRows = vi.hoisted(() => vi.fn());
vi.mock("../tabular.rows", () => ({ loadReviewRows }));

import {
    deleteTabularReviewChat,
    listTabularReviewChatMessages,
    listTabularReviewChats,
    prepareTabularChat,
    titleTabularChat,
    updateTabularReviewChat,
} from "../tabular.chats";
import { callTo, makeFakeDb } from "./fakeDb";

const WHO = { userId: "user-1", userEmail: "me@example.com" };
const REVIEW = {
    id: "rev-1",
    user_id: "user-1",
    project_id: null,
    title: "Lease review",
    columns_config: [{ index: 0, name: "A" }],
};

beforeEach(() => {
    vi.clearAllMocks();
    ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: true });
    loadReviewRows.mockResolvedValue([
        { id: "row-1", label: "Contract.pdf" },
    ]);
    getUserModelSettings.mockResolvedValue({
        api_keys: {},
        last_selected_chat_model: null,
        last_selected_reasoning_level: null,
        title_model: null,
    });
    resolveEffectiveChatModel.mockResolvedValue({
        ok: true,
        model: "claude-sonnet-5",
    });
    persistLastSelectedChatModel.mockResolvedValue(null);
    persistLastSelectedReasoningLevel.mockResolvedValue(null);
});

describe("listTabularReviewChats", () => {
    it("404s when review access is refused", async () => {
        ensureReviewAccess.mockResolvedValue({ ok: false });
        const { db } = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
        });
        const result = await listTabularReviewChats(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Review not found",
        });
    });

    it("returns every member's chats once review access is granted", async () => {
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: { data: REVIEW, error: null },
                tabular_review_chats: {
                    data: [{ id: "chat-1", user_id: "someone-else" }],
                    error: null,
                },
            },
        });
        const result = await listTabularReviewChats(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toMatchObject({
            ok: true,
            data: [{ id: "chat-1", user_id: "someone-else" }],
        });
        // Scoped by review only — deliberately NOT by requester.
        expect(callTo(calls, "tabular_review_chats")?.filters).toEqual({
            review_id: "rev-1",
        });
    });
});

describe("deleteTabularReviewChat", () => {
    it("scopes the delete to the caller's own chat", async () => {
        const { db, calls } = makeFakeDb();
        const result = await deleteTabularReviewChat(db, {
            chatId: "chat-1",
            userId: "user-1",
        });
        expect(result).toEqual({ ok: true, data: null });
        expect(callTo(calls, "tabular_review_chats")).toMatchObject({
            op: "delete",
            filters: { id: "chat-1", user_id: "user-1" },
        });
    });
});

describe("updateTabularReviewChat", () => {
    const patch = (body: Record<string, unknown>, spec = {}) =>
        updateTabularReviewChat(makeFakeDb(spec).db, {
            reviewId: "rev-1",
            chatId: "chat-1",
            userId: "user-1",
            body,
        });

    it("names the unsupported field it rejected", async () => {
        const result = await patch({ colour: "red" });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "Unsupported chat field: colour",
        });
    });

    it("rejects an empty patch", async () => {
        const result = await patch({});
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "title, model, or reasoningLevel is required",
        });
    });

    it("rejects a blank title", async () => {
        const result = await patch({ title: "   " });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "title is required",
        });
    });

    it("404s a chat that is not the caller's on this review", async () => {
        const result = await patch(
            { title: "New" },
            { tables: { tabular_review_chats: { data: null, error: null } } },
        );
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Chat not found",
        });
    });

    it("truncates a long title and stamps updated_at", async () => {
        const fake = makeFakeDb({
            tables: {
                tabular_review_chats: [
                    { data: { id: "chat-1", model: null }, error: null },
                    { data: { id: "chat-1", title: "x" }, error: null },
                ],
            },
        });
        const result = await updateTabularReviewChat(fake.db, {
            reviewId: "rev-1",
            chatId: "chat-1",
            userId: "user-1",
            body: { title: "t".repeat(500) },
        });
        expect(result.ok).toBe(true);
        const payload = fake.calls.find((c) => c.op === "update")
            ?.payload as Record<string, unknown>;
        expect((payload.title as string).length).toBe(200);
        expect(payload.updated_at).toEqual(expect.any(String));
    });

    it("carries a model-policy rejection through with its status", async () => {
        resolveEffectiveChatModel.mockResolvedValue({
            ok: false,
            status: 422,
            code: "missing_api_key",
            detail: "no key",
        });
        const result = await patch(
            { model: "claude-sonnet-5" },
            {
                tables: {
                    tabular_review_chats: {
                        data: { id: "chat-1", model: null },
                        error: null,
                    },
                },
            },
        );
        expect(result).toMatchObject({
            ok: false,
            kind: "status",
            status: 422,
            body: { code: "missing_api_key", detail: "no key" },
        });
    });
});

describe("listTabularReviewChatMessages", () => {
    it("404s a chat that belongs to a different review", async () => {
        const { db } = makeFakeDb({
            tables: {
                tabular_reviews: { data: REVIEW, error: null },
                tabular_review_chats: {
                    data: { id: "chat-1", review_id: "other-review" },
                    error: null,
                },
            },
        });
        const result = await listTabularReviewChatMessages(db, {
            reviewId: "rev-1",
            chatId: "chat-1",
            ...WHO,
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Chat not found",
        });
    });

    it("returns the chat's messages in insertion order", async () => {
        const { db } = makeFakeDb({
            tables: {
                tabular_reviews: { data: REVIEW, error: null },
                tabular_review_chats: {
                    data: { id: "chat-1", review_id: "rev-1" },
                    error: null,
                },
                tabular_review_chat_messages: {
                    data: [{ id: "m1", role: "user" }],
                    error: null,
                },
            },
        });
        const result = await listTabularReviewChatMessages(db, {
            reviewId: "rev-1",
            chatId: "chat-1",
            ...WHO,
        });
        expect(result).toMatchObject({ ok: true, data: [{ id: "m1" }] });
    });
});

describe("prepareTabularChat", () => {
    const base = {
        reviewId: "rev-1",
        ...WHO,
        messages: [{ role: "user" as const, content: "hi" }],
        lastUserContent: "hi",
        chatId: undefined,
        requestedModel: undefined,
        requestedReasoning: undefined,
    };

    it("404s an unreachable review", async () => {
        ensureReviewAccess.mockResolvedValue({ ok: false });
        const { db } = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW, error: null } },
        });
        const result = await prepareTabularChat(db, base);
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Review not found",
        });
    });

    it("creates a chat, stores the user turn, and builds the prompt", async () => {
        const fake = makeFakeDb({
            tables: {
                tabular_reviews: { data: REVIEW, error: null },
                tabular_cells: {
                    data: [
                        {
                            column_index: 0,
                            row_id: "row-1",
                            content: '{"summary":"yes"}',
                        },
                    ],
                    error: null,
                },
                tabular_review_chats: {
                    data: { id: "chat-new", title: null },
                    error: null,
                },
            },
        });
        const result = await prepareTabularChat(fake.db, base);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.chatId).toBe("chat-new");
        expect(result.data.isFirstExchange).toBe(true);
        expect(result.data.model).toBe("claude-sonnet-5");
        expect(result.data.tabularStore.cells.get("0:row-1")).toMatchObject({
            summary: "yes",
        });
        // The system prompt names the review so the model has its context.
        expect(JSON.stringify(result.data.apiMessages)).toContain(
            "Lease review",
        );
        expect(callTo(fake.calls, "tabular_review_chat_messages")).toMatchObject(
            {
                op: "insert",
                payload: { chat_id: "chat-new", role: "user", content: "hi" },
            },
        );
    });

    it("refuses to adopt a chat id belonging to another review", async () => {
        const fake = makeFakeDb({
            tables: {
                tabular_reviews: { data: REVIEW, error: null },
                tabular_review_chats: [
                    // The lookup of the supplied chat id…
                    {
                        data: {
                            id: "chat-foreign",
                            review_id: "some-other-review",
                            user_id: "user-1",
                        },
                        error: null,
                    },
                    // …then the insert of a fresh one for THIS review.
                    { data: { id: "chat-new", title: null }, error: null },
                ],
            },
        });
        const result = await prepareTabularChat(fake.db, {
            ...base,
            chatId: "chat-foreign",
        });
        expect(result.ok && result.data.chatId).toBe("chat-new");
    });

    it("500s with its own wording when the chat row cannot be created", async () => {
        const { db } = makeFakeDb({
            tables: {
                tabular_reviews: { data: REVIEW, error: null },
                tabular_review_chats: { data: null, error: { m: "boom" } },
            },
        });
        const result = await prepareTabularChat(db, base);
        expect(result).toMatchObject({
            ok: false,
            kind: "status",
            status: 500,
            body: { detail: "Failed to create chat" },
        });
    });
});

describe("titleTabularChat", () => {
    const args = {
        chatId: "chat-1",
        titleModel: "claude-haiku-5",
        userContent: "hi",
        reviewTitle: "Lease review",
        projectName: null,
        apiKeys: {},
    };

    it("persists and returns the generated title", async () => {
        generateChatTitle.mockResolvedValue("A good name");
        const fake = makeFakeDb();
        const title = await titleTabularChat(fake.db, args);
        expect(title).toBe("A good name");
        expect(callTo(fake.calls, "tabular_review_chats")).toMatchObject({
            op: "update",
            payload: { title: "A good name" },
            filters: { id: "chat-1" },
        });
    });

    it("leaves the chat untitled when the model declines", async () => {
        generateChatTitle.mockResolvedValue("");
        const fake = makeFakeDb();
        expect(await titleTabularChat(fake.db, args)).toBeNull();
        expect(fake.calls).toEqual([]);
    });
});
