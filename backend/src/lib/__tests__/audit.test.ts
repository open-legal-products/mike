import { afterEach, describe, it, expect, vi } from "vitest";
import { AppError } from "../appError";

const mocks = vi.hoisted(() => ({
    reportError: vi.fn((..._args: unknown[]) => "event-1"),
    enqueueDbJob: vi.fn(),
}));
vi.mock("../observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reportError: mocks.reportError,
}));
vi.mock("../dbq/enqueue", () => ({
    enqueueDbJob: (...args: unknown[]) => mocks.enqueueDbJob(...args),
}));
import {
    chatTurnAuditEvents,
    enqueueChatTurnAudit,
    recordAudit,
    recordChatTurn,
} from "../audit";

type Insert = Record<string, unknown>;

/**
 * Minimal Supabase mock that captures every audit_events insert so tests can
 * assert on the exact rows recordChatTurn mines from a turn's events.
 */
function makeDb() {
    const inserts: Insert[] = [];
    const db = {
        from(_table: string) {
            return {
                insert(row: Insert) {
                    inserts.push(row);
                    return Promise.resolve({ error: null });
                },
            };
        },
    };
    return { db: db as any, inserts };
}

const base = {
    userId: "u1",
    userEmail: "u1@example.com",
    chatId: "chat1",
    projectId: null,
    title: "My chat",
    model: "claude-x",
};

describe("recordChatTurn artifact mining", () => {
    it("records a chat.message row plus mined artifact rows", async () => {
        const { db, inserts } = makeDb();
        await recordChatTurn(db, base, [
            { type: "doc_created", filename: "brief.docx", document_id: "d1" },
            { type: "doc_edited", filename: "memo.docx", document_id: "d2" },
            { type: "workflow_applied", workflow_id: "wf1", title: "Cleanup" },
        ]);

        expect(inserts.map((r) => r.action)).toEqual([
            "chat.message",
            "document.generated",
            "document.edited",
            "workflow.applied",
        ]);
        expect(inserts[1]).toMatchObject({ title: "brief.docx", document_id: "d1" });
        expect(inserts[3]).toMatchObject({
            action: "workflow.applied",
            detail: { workflow_id: "wf1" },
        });
    });

    it("mines doc_replicated from its copies, not the source filename/id", async () => {
        const { db, inserts } = makeDb();
        await recordChatTurn(db, base, [
            {
                type: "doc_replicated",
                filename: "source-template.docx", // the SOURCE, not a produced copy
                count: 2,
                copies: [
                    { new_filename: "copy-a.docx", document_id: "da", version_id: "va" },
                    { new_filename: "copy-b.docx", document_id: "db", version_id: "vb" },
                ],
            },
        ]);

        // chat.message + one document.generated per copy.
        const artifacts = inserts.filter((r) => r.action === "document.generated");
        expect(artifacts).toHaveLength(2);
        expect(artifacts.map((r) => r.title)).toEqual(["copy-a.docx", "copy-b.docx"]);
        expect(artifacts.map((r) => r.document_id)).toEqual(["da", "db"]);
        // The source filename must never leak in as a title, and the (absent)
        // top-level document_id must never produce a null-id row.
        expect(inserts.some((r) => r.title === "source-template.docx")).toBe(false);
    });

    it("emits no artifact rows for a doc_replicated with empty copies", async () => {
        const { db, inserts } = makeDb();
        await recordChatTurn(db, base, [
            { type: "doc_replicated", filename: "src.docx", count: 0, copies: [] },
        ]);
        expect(inserts.map((r) => r.action)).toEqual(["chat.message"]);
    });
});

describe("chatTurnAuditEvents surface", () => {
    it("derives assistant/project from projectId when no surface is given", () => {
        expect(chatTurnAuditEvents(base, [])[0].surface).toBe("assistant");
        expect(
            chatTurnAuditEvents({ ...base, projectId: "p1" }, [])[0].surface,
        ).toBe("project");
    });

    it("lets an explicit surface override the derivation, on every row", () => {
        const rows = chatTurnAuditEvents({ ...base, surface: "word" }, [
            { type: "doc_created", filename: "brief.docx", document_id: "d1" },
        ]);
        // Both the chat.message row and the mined artifact row must carry it,
        // or the history feed would show a Word turn with an assistant
        // artifact hanging off it.
        expect(rows.map((r) => r.surface)).toEqual(["word", "word"]);
    });

    it("wins over projectId rather than being overridden by it", () => {
        const rows = chatTurnAuditEvents(
            { ...base, projectId: "p1", surface: "word" },
            [],
        );
        expect(rows[0].surface).toBe("word");
        expect(rows[0].projectId).toBe("p1");
    });
});

// Recording an event never throws, so the report is the only trace a lost
// audit row leaves: one event, the kind naming it, the real error as cause.
describe("audit write failure reporting", () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });

    it("reports a lost audit row under audit.write_failed with the PostgREST error as cause, and never throws", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const cause = { code: "42P01", message: 'relation "audit_events" does not exist' };
        const db = {
            from: () => ({ insert: () => Promise.resolve({ error: cause }) }),
        } as any;

        await expect(
            recordAudit(db, { userId: "u1", action: "chat.message" }),
        ).resolves.toBeUndefined();

        expect(mocks.reportError).toHaveBeenCalledOnce();
        const [failure, context] = mocks.reportError.mock.calls[0] as unknown as [
            AppError,
            { extra?: Record<string, unknown> },
        ];
        expect(failure).toBeInstanceOf(AppError);
        expect(failure.kind).toBe("audit.write_failed");
        expect(failure.cause).toBe(cause);
        expect(context.extra).toEqual({ action: "chat.message" });
        expect((context as { tags?: unknown }).tags).toEqual({ operation: "audit.write" });
        // The log line carries the reported object, so the console bridge
        // files nothing twice.
        expect(console.error).toHaveBeenCalledWith("[audit] insert threw:", failure);
    });

    it("reports a failed chat-turn enqueue as a warning, then records the rows directly", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const cause = new Error("db_jobs insert failed");
        mocks.enqueueDbJob.mockRejectedValue(cause);
        const { db, inserts } = makeDb();

        await enqueueChatTurnAudit(db, base, [
            { type: "doc_created", filename: "brief.docx", document_id: "d1" },
        ]);

        expect(inserts.map((r) => r.action)).toEqual([
            "chat.message",
            "document.generated",
        ]);
        expect(mocks.reportError).toHaveBeenCalledOnce();
        const [failure, context] = mocks.reportError.mock.calls[0] as unknown as [
            AppError,
            { level?: string },
        ];
        expect(failure.kind).toBe("audit.write_failed");
        expect(failure.cause).toBe(cause);
        expect(context.level).toBe("warning");
    });
});
