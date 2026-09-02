import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Integration tests must never leave the process: anything a route needs
// from the network has to arrive through a mock. A real fetch is what made
// this suite flaky — chat-title generation called the live provider with the
// test's fake key, so the test's fate rode on that socket (fast 401 = pass,
// slow response or SDK retry loop = 20s timeout). Reject instantly and
// loudly instead, so the next unmocked path fails in milliseconds with a
// URL in the message rather than an unexplained timeout.
vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
        throw new Error(
            `integration test attempted a real network call: ${String(input)}`,
        );
    }),
);

// The title generator is the one route dependency that talks to a live LLM
// provider; give it a deterministic answer so the chat_title SSE event flows
// through the success path instead of depending on how fast a real provider
// rejects the test's fake API key.
vi.mock("../../lib/chatTitle", () => ({
    generateAssistantChatTitle: vi.fn(async () => "Test Generated Title"),
}));

// Hoisted mock fn so the vi.mock factory below (which is itself hoisted above
// the imports) can reference it. Lets each test drive the stream outcome.
const { runLLMStream, dbInserts, dbUpdates, dbControl } = vi.hoisted(() => ({
    runLLMStream: vi.fn(),
    dbInserts: [] as { table: string; value: unknown }[],
    dbUpdates: [] as {
        table: string;
        value: unknown;
        filters: { column: string; value: unknown }[];
    }[],
    dbControl: {
        failAssistantReservation: false,
        terminalUpdateFailures: 0,
        terminalUpdateAttempts: 0,
        terminalUpdateGate: null as Promise<void> | null,
        wordChatMissing: false,
        // When set, selects on chat_messages resolve against these rows with
        // the eq/not/order/limit chain genuinely applied (a mini query
        // engine), so tests can prove which assistant row a query picks.
        assistantMessageRows: null as Record<string, unknown>[] | null,
    },
}));

// A permissive, chainable Supabase stub. Every query-builder method returns the
// same object (so arbitrary chains work), the object is awaitable (thenable),
// and the terminal single()/maybeSingle() resolve to a chat row. The chat
// routes only read `.id`/`.title` and check `.error`, so this is enough to let
// a request flow through chat creation and message inserts without real IO.
function makeQuery(table: string) {
    let result: { data: unknown; error: { message: string } | null } = {
        data: {
            id: "chat-1",
            title: null,
            user_id: "u1",
            project_id: null,
        },
        error: null,
    };
    const q: Record<string, unknown> = {};
    let activeUpdate:
        | {
              table: string;
              value: unknown;
              filters: { column: string; value: unknown }[];
          }
        | undefined;
    const chain = [
        "delete",
        "upsert",
        "neq",
        "in",
        "is",
        "or",
        "lt",
        "gt",
        "gte",
        "lte",
        "filter",
        "range",
        "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    // Select-chain state, applied against dbControl.assistantMessageRows when
    // the query resolves (see q.then below).
    let didSelect = false;
    const selectState = {
        filters: [] as { column: string; op: string; value: unknown }[],
        order: null as { column: string; ascending: boolean } | null,
        limit: null as number | null,
    };
    q.select = vi.fn(() => {
        didSelect = true;
        return q;
    });
    q.not = vi.fn((column: string, operator: string, value: unknown) => {
        selectState.filters.push({ column, op: `not-${operator}`, value });
        return q;
    });
    q.order = vi.fn((column: string, opts?: { ascending?: boolean }) => {
        selectState.order = { column, ascending: opts?.ascending !== false };
        return q;
    });
    q.limit = vi.fn((count: number) => {
        selectState.limit = count;
        return q;
    });
    q.insert = vi.fn((value: unknown) => {
        dbInserts.push({ table, value });
        if (
            dbControl.failAssistantReservation &&
            table === "chat_messages" &&
            (value as { role?: unknown }).role === "assistant"
        ) {
            result = {
                data: null,
                error: { message: "assistant reservation failed" },
            };
        }
        return q;
    });
    q.update = vi.fn((value: unknown) => {
        activeUpdate = { table, value, filters: [] };
        dbUpdates.push(activeUpdate);
        return q;
    });
    q.eq = vi.fn((column: string, value: unknown) => {
        if (activeUpdate) activeUpdate.filters.push({ column, value });
        else selectState.filters.push({ column, op: "eq", value });
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() =>
        Promise.resolve(
            table === "word_chats" && dbControl.wordChatMissing
                ? { data: null, error: null }
                : result,
        ),
    );
    q.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
    ) => {
        const resolveQuery = async () => {
            if (activeUpdate?.table === "chat_messages") {
                dbControl.terminalUpdateAttempts += 1;
                if (dbControl.terminalUpdateGate) {
                    await dbControl.terminalUpdateGate;
                }
                if (
                    dbControl.terminalUpdateAttempts <=
                    dbControl.terminalUpdateFailures
                ) {
                    return {
                        data: null,
                        error: {
                            message: `terminal update failed (attempt ${dbControl.terminalUpdateAttempts})`,
                        },
                    };
                }
            }
            if (
                !activeUpdate &&
                didSelect &&
                table === "chat_messages" &&
                dbControl.assistantMessageRows
            ) {
                let rows = [...dbControl.assistantMessageRows];
                for (const f of selectState.filters) {
                    if (f.op === "eq") {
                        rows = rows.filter((row) => row[f.column] === f.value);
                    } else if (f.op === "not-is" && f.value === null) {
                        rows = rows.filter((row) => row[f.column] !== null);
                    }
                }
                if (selectState.order) {
                    const { column, ascending } = selectState.order;
                    rows = [...rows].sort(
                        (a, b) =>
                            String(a[column]).localeCompare(String(b[column])) *
                            (ascending ? 1 : -1),
                    );
                }
                if (selectState.limit != null) {
                    rows = rows.slice(0, selectState.limit);
                }
                return { data: rows, error: null };
            }
            return result;
        };
        return resolveQuery().then(resolve, reject);
    };
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

// Authenticate every request as user "u1" without exercising the real Supabase
// JWT path. requireMfaIfEnrolled must be exported too — userRouter (mounted by
// the app) imports it at module load.
vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// Keep the real error helpers (the failure-path test relies on genuine
// isAbortError + AssistantStreamError behavior) but stub the functions that
// would otherwise hit the DB or the LLM.
vi.mock("../../lib/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/chat")>();
    return {
        ...actual,
        buildDocContext: vi.fn(async () => ({
            docIndex: {},
            docStore: new Map(),
        })),
        enrichWithPriorEvents: vi.fn(async (messages: unknown) => messages),
        buildWorkflowStore: vi.fn(async () => new Map()),
        buildMessages: vi.fn(() => []),
        runLLMStream: (...args: unknown[]) => runLLMStream(...args),
    };
});

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: vi.fn(async () => ({
        legal_research_us: false,
        title_model: "test-model",
        tabular_model: "test-model",
        last_selected_chat_model: null,
        last_selected_reasoning_level: null,
        api_keys: { gemini: "test-key" },
        personalisation: {
            displayName: "Ada",
            organisation: "Acme LLP",
            jurisdiction: "Singapore",
            practiceSetting: "private_practice",
            professionalTitle: "Partner",
            practiceAreas: ["Litigation"],
        },
    })),
    persistLastSelectedChatModel: vi.fn(async () => null),
    persistLastSelectedReasoningLevel: vi.fn(async () => null),
    getUserApiKeys: vi.fn(async () => ({})),
}));

import { app } from "../../app";

const VALID_BODY = {
    messages: [{ role: "user", content: "hello" }],
    model: "gemini-3-flash-preview",
};

function findAssistantReservation() {
    return dbInserts.find(
        ({ table, value }) =>
            table === "chat_messages" &&
            (value as { role?: unknown }).role === "assistant",
    );
}

function findAssistantUpdate() {
    return dbUpdates.find(({ table }) => table === "chat_messages");
}

describe("POST /chat — streaming endpoint", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbInserts.length = 0;
        dbUpdates.length = 0;
        dbControl.failAssistantReservation = false;
        dbControl.terminalUpdateFailures = 0;
        dbControl.terminalUpdateAttempts = 0;
        dbControl.terminalUpdateGate = null;
        dbControl.wordChatMissing = false;
        dbControl.assistantMessageRows = null;
        runLLMStream.mockResolvedValue({
            fullText: "hi there",
            events: [],
            citations: [],
        });
    });

    it("streams SSE with a chat_id event on the happy path", async () => {
        const chatLib = await import("../../lib/chat");
        let reservationExistedBeforeStreaming = false;
        runLLMStream.mockImplementation(async () => {
            reservationExistedBeforeStreaming = !!findAssistantReservation();
            return {
                fullText: "hi there",
                events: [{ type: "content", text: "hi there" }],
                citations: [],
            };
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.text).toContain('"type":"chat_id"');
        expect(res.text).toContain('"type":"chat_title"');
        expect(runLLMStream).toHaveBeenCalledTimes(1);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ emitDone: false }),
        );
        const systemPromptExtra = vi.mocked(chatLib.buildMessages).mock
            .calls[0]?.[2] as string;
        expect(systemPromptExtra).toContain("USER PERSONALISATION");
        expect(systemPromptExtra).toContain('"title": "Partner"');
        expect(systemPromptExtra).toContain(
            '"professional_setting": "Private practice"',
        );

        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { chatId: string; assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(reservationExistedBeforeStreaming).toBe(true);
        expect(metadata.assistantMessageId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            chat_id: metadata.chatId,
            role: "assistant",
            content: null,
            citations: null,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: [{ type: "content", text: "hi there" }],
            citations: null,
        });
        expect(assistantUpdate?.filters).toEqual(
            expect.arrayContaining([
                { column: "id", value: metadata.assistantMessageId },
                { column: "chat_id", value: metadata.chatId },
            ]),
        );
    });

    it("rejects a chat without an explicit model before streaming", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: VALID_BODY.messages });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            code: "model_required",
            detail: "Select a model before sending a message.",
        });
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("uses the profile last-selected model when a new chat omits model", async () => {
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            legal_research_us: false,
            title_model: null,
            tabular_model: null,
            last_selected_chat_model: "gpt-5.6-luna",
            api_keys: { openai: "test-key" },
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: VALID_BODY.messages });

        expect(res.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ model: "gpt-5.6-luna" }),
        );
        expect(dbInserts).toContainEqual({
            table: "chats",
            value: expect.objectContaining({ model: "gpt-5.6-luna" }),
        });
        expect(
            userSettings.persistLastSelectedChatModel,
        ).not.toHaveBeenCalled();
    });

    it("surfaces an empty upstream completion as a visible retry error", async () => {
        // Some providers end the stream cleanly but produce no content.
        // Silence reads as a hung composer, so the route emits an explicit,
        // safe-to-display error event before closing the stream.
        runLLMStream.mockResolvedValue({
            fullText: "",
            events: [],
            citations: [],
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.text).toContain('"type":"error"');
        expect(res.text).toContain("empty response");
        expect(res.text).toContain('"safe_to_display":true');
        expect(res.text).toContain("[DONE]");
    });

    it("stores cloud Word chats only in the document-scoped Word tables", async () => {
        const chatLib = await import("../../lib/chat");
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: [{ role: "user", content: "Visible prompt" }],
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "Contract.docx",
                storage: "cloud",
                document_context: "GOVERNED BY DELAWARE LAW",
                model: "gemini-3-flash-preview",
            });

        expect(res.status).toBe(200);
        expect(dbInserts.some(({ table }) => table === "chats")).toBe(false);
        expect(dbInserts.some(({ table }) => table === "chat_messages")).toBe(
            false,
        );
        expect(dbInserts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    table: "word_chats",
                    value: expect.objectContaining({
                        user_id: "u1",
                        word_document_id: "chat-1",
                    }),
                }),
                expect.objectContaining({
                    table: "word_chat_messages",
                    value: expect.objectContaining({
                        role: "user",
                        content: "Visible prompt",
                    }),
                }),
                expect.objectContaining({
                    table: "word_chat_messages",
                    value: expect.objectContaining({ role: "assistant" }),
                }),
            ]),
        );
        const call = vi.mocked(chatLib.buildMessages).mock.calls[0];
        const docAvailability = call[1] as {
            doc_id: string;
            filename: string;
        }[];
        const systemPromptExtra = call[2] as string;
        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            docStore: Map<
                string,
                {
                    filename: string;
                    inline_text?: string;
                }
            >;
        };
        expect(systemPromptExtra).toContain("running inside Microsoft Word");
        expect(systemPromptExtra).toContain("USER PERSONALISATION");
        expect(systemPromptExtra).toContain('"jurisdiction": "Singapore"');
        expect(systemPromptExtra).toContain(
            '\"deleted_text\":\"exact text copied from the active Word document\"',
        );
        expect(systemPromptExtra).not.toContain("GOVERNED BY DELAWARE LAW");
        expect(docAvailability).toContainEqual({
            doc_id: "active-word-document",
            filename: "Contract.docx",
        });
        expect(streamArgs.docStore.get("active-word-document")).toMatchObject({
            filename: "Contract.docx",
            inline_text: "GOVERNED BY DELAWARE LAW",
        });
        expect(
            dbInserts.find(
                ({ table, value }) =>
                    table === "word_chat_messages" &&
                    (value as { role?: unknown }).role === "user",
            )?.value,
        ).toMatchObject({ content: "Visible prompt" });
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ includeAskInputs: false }),
        );
    });

    it.each([
        [{ messages: VALID_BODY.messages }, "document_id must be a UUID"],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "   ",
            },
            "document_name must be a non-empty string",
        ],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "weird",
            },
            'storage must be "cloud" or "local"',
        ],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                chat_id: "not-a-uuid",
            },
            "chat_id must be a UUID",
        ],
    ])(
        "rejects invalid Word-chat input before streaming",
        async (body, detail) => {
            const res = await request(app)
                .post("/word-chat")
                .set("Authorization", "Bearer test")
                .send(body);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(detail);
            expect(runLLMStream).not.toHaveBeenCalled();
            expect(dbInserts).toEqual([]);
        },
    );

    it("rejects a Word chat without an explicit model before creating storage", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: VALID_BODY.messages,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "cloud",
            });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("model_required");
        expect(dbInserts).toEqual([]);
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("uses the shared last-selected model for a local Word chat", async () => {
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            legal_research_us: false,
            title_model: null,
            tabular_model: null,
            last_selected_chat_model: "gpt-5.6-luna",
            api_keys: { openai: "test-key" },
        });

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: VALID_BODY.messages,
                storage: "local",
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
            });

        expect(res.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ model: "gpt-5.6-luna" }),
        );
    });

    it("rejects a resumed Word chat outside the scoped document and user", async () => {
        dbControl.wordChatMissing = true;

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                chat_id: "96fdeaa1-af40-475e-9834-703004783f21",
                storage: "cloud",
            });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Chat not found");
        expect(runLLMStream).not.toHaveBeenCalled();
        expect(
            dbInserts.some(({ table }) => table === "word_chat_messages"),
        ).toBe(false);
    });

    it("streams local Word chats without inserting any chat rows", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "96fdeaa1-af40-475e-9834-703004783f21",
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "local",
            });

        expect(res.status).toBe(200);
        expect(res.text).toContain(
            '"chatId":"96fdeaa1-af40-475e-9834-703004783f21"',
        );
        // No chat row, no message row: local storage means the transcript
        // never reaches the server. The audit job below is the one permitted
        // write — it records THAT a Word turn happened, deliberately without
        // the prompt text (see the title it carries).
        expect(dbInserts.map(({ table }) => table)).toEqual(["db_jobs"]);
        const auditJob = dbInserts[0].value as {
            kind: string;
            payload: { base: { surface: string; title: string | null } };
        };
        expect(auditJob.kind).toBe("audit.chat_turn");
        expect(auditJob.payload.base.surface).toBe("word");
        expect(auditJob.payload.base.title).not.toContain("hello");
        expect(dbUpdates).toEqual([]);
        expect(runLLMStream).toHaveBeenCalledTimes(1);
    });

    it("does not finish the SSE response until the terminal assistant update succeeds", async () => {
        let releaseTerminalUpdate!: () => void;
        dbControl.terminalUpdateGate = new Promise<void>((resolve) => {
            releaseTerminalUpdate = resolve;
        });

        let requestSettled = false;
        const responsePromise = request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY)
            .then((response) => {
                requestSettled = true;
                return response;
            });

        await vi.waitFor(() => {
            expect(dbControl.terminalUpdateAttempts).toBe(1);
        });
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ emitDone: false }),
        );
        expect(requestSettled).toBe(false);

        releaseTerminalUpdate();
        const res = await responsePromise;

        expect(requestSettled).toBe(true);
        expect(res.text).toContain("data: [DONE]");
        expect(res.text).not.toContain(
            "The response was generated but could not be saved",
        );
    });

    it("retries a failed terminal assistant update up to success", async () => {
        dbControl.terminalUpdateFailures = 2;

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(dbControl.terminalUpdateAttempts).toBe(3);
        expect(
            dbUpdates.filter(({ table }) => table === "chat_messages"),
        ).toHaveLength(3);
        expect(res.text).toContain("data: [DONE]");
        expect(res.text).not.toContain(
            "The response was generated but could not be saved",
        );
    });

    it("reports a terminal persistence failure before ending the SSE stream", async () => {
        dbControl.terminalUpdateFailures = 3;
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(dbControl.terminalUpdateAttempts).toBe(3);
        expect(
            dbUpdates.filter(({ table }) => table === "chat_messages"),
        ).toHaveLength(3);

        const errorIndex = res.text.indexOf(
            "The response was generated but could not be saved",
        );
        const doneIndex = res.text.indexOf("data: [DONE]");
        expect(errorIndex).toBeGreaterThanOrEqual(0);
        expect(doneIndex).toBeGreaterThan(errorIndex);
        expect(errorSpy).toHaveBeenCalledWith(
            "[chat/stream] failed to save assistant response",
            expect.objectContaining({
                message: "terminal update failed (attempt 3)",
            }),
        );
        errorSpy.mockRestore();
    });

    it("fails before advertising SSE metadata when the assistant row cannot be reserved", async () => {
        dbControl.failAssistantReservation = true;
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(500);
        expect(res.headers["content-type"]).not.toContain("text/event-stream");
        expect(res.body.detail).toBe("Something went wrong. Please try again.");
        expect(res.text).not.toContain('"type":"chat_id"');
        expect(findAssistantReservation()).toBeDefined();
        expect(runLLMStream).not.toHaveBeenCalled();
        expect(findAssistantUpdate()).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
            "[chat/stream] failed to reserve assistant message",
            expect.objectContaining({
                message: "assistant reservation failed",
            }),
        );
        errorSpy.mockRestore();
    });

    it("surfaces a stream failure as an in-stream error event, not an HTTP error", async () => {
        runLLMStream.mockRejectedValue(new Error("upstream LLM failure"));

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        // Headers were already flushed (200) before the stream threw, so the
        // failure surfaces as an in-stream error event + [DONE].
        expect(res.status).toBe(200);
        expect(res.text).toContain('"type":"error"');
        expect(res.text).toContain("[DONE]");

        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            role: "assistant",
        });
        expect(assistantUpdate?.filters).toContainEqual({
            column: "id",
            value: metadata.assistantMessageId,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: [
                expect.objectContaining({
                    type: "error",
                    message:
                        "The response could not be completed. Please try again.",
                }),
            ],
        });
    });

    it("uses the streamed assistant message id when persisting a cancelled partial response", async () => {
        const { AssistantStreamAbortError } = await import("../../lib/chat");
        runLLMStream.mockRejectedValue(
            new AssistantStreamAbortError("partial", [
                { type: "content", text: "partial" },
            ]),
        );

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            role: "assistant",
        });
        expect(assistantUpdate?.filters).toContainEqual({
            column: "id",
            value: metadata.assistantMessageId,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: expect.arrayContaining([
                { type: "content", text: "partial" },
                { type: "content", text: "Cancelled by user." },
            ]),
        });
    });

    it("does not allocate or insert a new assistant message for an ask-input continuation", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "chat-1",
                ask_inputs_response: {
                    responses: [
                        {
                            id: "choice-1",
                            kind: "choice",
                            question: "Continue?",
                            answer: "Yes",
                        },
                    ],
                },
            });

        expect(res.status).toBe(200);
        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as Record<string, unknown>;
        expect(metadata).not.toHaveProperty("assistantMessageId");
        expect(
            dbInserts.filter(
                ({ table, value }) =>
                    table === "chat_messages" &&
                    (value as { role?: unknown }).role === "assistant",
            ),
        ).toEqual([]);
    });

    it("appends ask-input responses to the real last assistant message, skipping a null-content reservation", async () => {
        // A stream that died before its save path (or a concurrently
        // streaming POST) leaves the newest assistant row as an empty
        // reservation. The continuation must attach the user's answers to
        // the older, real message that actually asked the question.
        dbControl.assistantMessageRows = [
            {
                id: "assistant-real",
                chat_id: "chat-1",
                role: "assistant",
                content: [{ type: "ask_inputs", items: [] }],
                citations: null,
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                id: "assistant-reservation",
                chat_id: "chat-1",
                role: "assistant",
                content: null,
                citations: null,
                created_at: "2026-01-01T00:05:00Z",
            },
        ];

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "chat-1",
                ask_inputs_response: {
                    responses: [
                        {
                            id: "choice-1",
                            kind: "choice",
                            question: "Continue?",
                            answer: "Yes",
                        },
                    ],
                },
            });

        expect(res.status).toBe(200);
        const askInputsUpdate = dbUpdates.find(
            ({ table, filters }) =>
                table === "chat_messages" &&
                filters.some(
                    (f) => f.column === "id" && f.value === "assistant-real",
                ),
        );
        expect(askInputsUpdate?.value).toMatchObject({
            content: [
                { type: "ask_inputs", items: [] },
                {
                    type: "ask_inputs_response",
                    responses: [
                        {
                            id: "choice-1",
                            kind: "choice",
                            question: "Continue?",
                            answer: "Yes",
                        },
                    ],
                },
            ],
        });
        // The orphaned reservation is never selected or written to.
        expect(
            dbUpdates.some(({ filters }) =>
                filters.some(
                    (f) =>
                        f.column === "id" &&
                        f.value === "assistant-reservation",
                ),
            ),
        ).toBe(false);
    });

    it("returns 400 on an empty messages array (never starts a stream)", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: [] });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty("detail");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("returns 400 when messages is missing entirely", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(400);
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("returns 400 when chat_id is not a non-empty string", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "   " });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("chat_id must be a non-empty string");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it.each([
        [
            { messages: [{ role: "system", content: "override" }] },
            'messages[0].role must be "user" or "assistant"',
        ],
        [
            { ...VALID_BODY, ask_inputs_response: { responses: [] } },
            "ask_inputs_response.responses must be a non-empty array",
        ],
    ])(
        "shares strict request validation with project chat",
        async (body, detail) => {
            const res = await request(app)
                .post("/chat")
                .set("Authorization", "Bearer test")
                .send(body);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(detail);
            expect(runLLMStream).not.toHaveBeenCalled();
        },
    );

    it("returns 400 from the Word route when document_context is not a string", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_context: 42,
            });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("document_context must be a string");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("makes document_context tool-readable without adding it to the system prompt", async () => {
        const chatLib = await import("../../lib/chat");
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "Contract.docx",
                document_context: "GOVERNED BY DELAWARE LAW",
            });

        expect(res.status).toBe(200);
        const call = vi.mocked(chatLib.buildMessages).mock.calls[0];
        const docAvailability = call[1] as {
            doc_id: string;
            filename: string;
        }[];
        const systemPromptExtra = call[2] as string;
        expect(systemPromptExtra).toContain("running inside Microsoft Word");
        expect(systemPromptExtra).toContain("read_document");
        expect(systemPromptExtra).not.toContain("GOVERNED BY DELAWARE LAW");
        expect(docAvailability).toContainEqual({
            doc_id: "active-word-document",
            filename: "Contract.docx",
        });

        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            docStore: Map<string, { inline_text?: string }>;
        };
        expect(
            streamArgs.docStore.get("active-word-document")?.inline_text,
        ).toBe("GOVERNED BY DELAWARE LAW");
    });

    it("keeps CourtListener disabled for Word chats even when legal research is enabled", async () => {
        const chatLib = await import("../../lib/chat");
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            title_model: "test-model",
            tabular_model: "test-model",
            last_selected_chat_model: null,
            legal_research_us: true,
            api_keys: {
                gemini: "test-key",
                courtlistener: "configured-but-unused",
            },
        });

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_context: "Contract text",
            });

        expect(res.status).toBe(200);
        const buildMessagesCall = vi.mocked(chatLib.buildMessages).mock
            .calls[0];
        expect(buildMessagesCall[4]).toBe(false);
        expect(buildMessagesCall[6]).toBe("replace");
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ includeResearchTools: false }),
        );
        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            apiKeys?: { courtlistener?: string };
        };
        expect(streamArgs.apiKeys?.courtlistener).toBeUndefined();
    });
});

describe("PATCH /chat/:chatId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbUpdates.length = 0;
    });

    it("returns 400 when no supported update is provided", async () => {
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "title, model, or reasoningLevel is required",
        );
    });

    it("updates the chat and profile when a model is selected", async () => {
        const userSettings = await import("../../lib/userSettings");
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ model: "gemini-3-flash-preview" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { model: "gemini-3-flash-preview" },
            filters: [{ column: "id", value: "chat-1" }],
        });
        expect(userSettings.persistLastSelectedChatModel).toHaveBeenCalledWith(
            "u1",
            "gemini-3-flash-preview",
            expect.anything(),
        );
    });

    it("updates the chat and profile when reasoning is selected", async () => {
        const userSettings = await import("../../lib/userSettings");
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ reasoningLevel: "xhigh" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { reasoning_level: "xhigh" },
            filters: [{ column: "id", value: "chat-1" }],
        });
        expect(
            userSettings.persistLastSelectedReasoningLevel,
        ).toHaveBeenCalledWith("u1", "xhigh", expect.anything());
    });
});

describe("PATCH /word-chat/:chatId/model", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbUpdates.length = 0;
        dbControl.wordChatMissing = false;
    });

    it("updates a cloud Word chat and the profile on selection", async () => {
        const userSettings = await import("../../lib/userSettings");
        const chatId = "6f783e59-35c4-4ddc-896a-94aa4d05a768";
        const documentId = "6f783e59-35c4-4ddc-896a-94aa4d05a767";
        const res = await request(app)
            .patch(`/word-chat/${chatId}/model`)
            .query({ document_id: documentId })
            .set("Authorization", "Bearer test")
            .send({ model: "gemini-3-flash-preview" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "word_chats",
            value: expect.objectContaining({
                model: "gemini-3-flash-preview",
            }),
            filters: [
                { column: "id", value: chatId },
                { column: "user_id", value: "u1" },
            ],
        });
        expect(userSettings.persistLastSelectedChatModel).toHaveBeenCalledWith(
            "u1",
            "gemini-3-flash-preview",
            expect.anything(),
        );
    });
});
