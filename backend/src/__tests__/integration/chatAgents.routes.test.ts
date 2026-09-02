import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/**
 * Route tests for highlight-assigned agents.
 *
 * These need a Supabase stub with real filtering — the interesting assertions
 * are "which rows came back" and "which row was written" — so instead of the
 * canned-row stub used by chat.routes.test.ts this file drives a tiny in-memory
 * table store. `db.rows` is the fixture surface each test arranges.
 */
const { runLLMStream, db } = vi.hoisted(() => ({
    runLLMStream: vi.fn(),
    db: {
        rows: {} as Record<string, Record<string, unknown>[]>,
        writes: [] as {
            table: string;
            op: "insert" | "update";
            value: Record<string, unknown>;
        }[],
        insertError: null as { message: string } | null,
    },
}));

type Filter = { column: string; op: "eq" | "is" | "in"; value: unknown };

function matches(row: Record<string, unknown>, filters: Filter[]) {
    return filters.every((filter) => {
        const actual = row[filter.column] ?? null;
        if (filter.op === "in") {
            return (filter.value as unknown[]).includes(actual);
        }
        // `.is(col, null)` and `.eq(col, v)` both compare by value here; the
        // store normalizes a missing column to null so an absent
        // `parent_chat_id` behaves like the SQL null it stands for.
        return actual === (filter.value ?? null);
    });
}

function makeQuery(table: string) {
    const filters: Filter[] = [];
    let order: { column: string; ascending: boolean } | null = null;
    let countMode = false;
    let pendingWrite: {
        op: "insert" | "update";
        value: Record<string, unknown>;
    } | null = null;

    const rows = () => (db.rows[table] ??= []);

    const selected = () => {
        const list = rows().filter((row) => matches(row, filters));
        if (!order) return list;
        const { column, ascending } = order;
        return [...list].sort(
            (a, b) =>
                String(a[column] ?? "").localeCompare(String(b[column] ?? "")) *
                (ascending ? 1 : -1),
        );
    };

    const resolve = async () => {
        if (pendingWrite?.op === "insert") {
            if (db.insertError) return { data: null, error: db.insertError };
            const row = { ...pendingWrite.value };
            rows().push(row);
            return { data: [row], error: null };
        }
        if (pendingWrite?.op === "update") {
            const targets = rows().filter((row) => matches(row, filters));
            for (const row of targets) Object.assign(row, pendingWrite.value);
            return { data: targets, error: null };
        }
        if (countMode) {
            return { data: null, error: null, count: selected().length };
        }
        return { data: selected(), error: null };
    };

    const q: Record<string, unknown> = {
        select: vi.fn((_cols?: string, opts?: { head?: boolean }) => {
            if (opts?.head) countMode = true;
            return q;
        }),
        eq: vi.fn((column: string, value: unknown) => {
            filters.push({ column, op: "eq", value });
            return q;
        }),
        is: vi.fn((column: string, value: unknown) => {
            filters.push({ column, op: "is", value });
            return q;
        }),
        in: vi.fn((column: string, value: unknown) => {
            filters.push({ column, op: "in", value });
            return q;
        }),
        order: vi.fn((column: string, opts?: { ascending?: boolean }) => {
            order = { column, ascending: opts?.ascending !== false };
            return q;
        }),
        limit: vi.fn(() => q),
        not: vi.fn(() => q),
        delete: vi.fn(() => q),
        insert: vi.fn((value: Record<string, unknown>) => {
            pendingWrite = { op: "insert", value };
            db.writes.push({ table, op: "insert", value });
            return q;
        }),
        update: vi.fn((value: Record<string, unknown>) => {
            pendingWrite = { op: "update", value };
            db.writes.push({ table, op: "update", value });
            return q;
        }),
        single: vi.fn(async () => {
            const { data, error } = await resolve();
            const list = (data ?? []) as Record<string, unknown>[];
            return list.length === 1
                ? { data: list[0], error }
                : { data: null, error: error ?? { message: "no rows" } };
        }),
        maybeSingle: vi.fn(async () => {
            const { data, error } = await resolve();
            const list = (data ?? []) as Record<string, unknown>[];
            return { data: list[0] ?? null, error };
        }),
    };
    (q as { then: unknown }).then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
    ) => resolve().then(onFulfilled, onRejected);
    return q;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(async () => ({ data: [], error: null })),
        auth: {
            getUser: async () => ({
                data: { user: { id: "u1" } },
                error: null,
            }),
        },
    })),
}));

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
        // A chat turn resolves no model without a usable key for it, so the
        // streaming route needs one here to reach the behaviour under test.
        api_keys: { gemini: "test-key" },
        personalisation: {
            displayName: "",
            organisation: "",
            jurisdiction: "",
            practiceSetting: "",
            professionalTitle: "",
            practiceAreas: [],
        },
    })),
    getUserApiKeys: vi.fn(async () => ({})),
}));

import { app } from "../../app";
import { MAX_ACTIVE_CHAT_AGENTS, PROPOSE_EDIT_TOOL_NAME } from "../../lib/chat";

const auth = (r: request.Test) => r.set("Authorization", "Bearer test");

const parentChat = (over: Record<string, unknown> = {}) => ({
    id: "parent-1",
    user_id: "u1",
    project_id: null,
    title: "Parent",
    parent_chat_id: null,
    created_at: "2026-08-26T10:00:00Z",
    ...over,
});

const agentChat = (over: Record<string, unknown> = {}) => ({
    id: "agent-1",
    user_id: "u1",
    project_id: null,
    title: "check the indemnity",
    parent_chat_id: "parent-1",
    agent_instruction: "check the indemnity",
    source_message_id: "msg-1",
    source_excerpt: "the indemnity clause",
    created_at: "2026-08-26T10:01:00Z",
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    db.rows = { chats: [], chat_messages: [] };
    db.writes = [];
    db.insertError = null;
    runLLMStream.mockResolvedValue({
        fullText: "ok",
        events: [{ type: "content", text: "ok" }],
        citations: [],
    });
});

describe("POST /chat/create — assigning an agent", () => {
    it("creates an agent parented to an accessible chat", async () => {
        db.rows.chats.push(parentChat());

        const res = await auth(request(app).post("/chat/create")).send({
            parent_chat_id: "parent-1",
            agent_instruction: "check the indemnity",
            source_message_id: "msg-1",
            source_excerpt: "the indemnity clause",
        });

        expect(res.status).toBe(200);
        const insert = db.writes.find(
            (write) => write.table === "chats" && write.op === "insert",
        );
        expect(insert?.value).toMatchObject({
            user_id: "u1",
            parent_chat_id: "parent-1",
            agent_instruction: "check the indemnity",
            source_message_id: "msg-1",
            source_excerpt: "the indemnity clause",
        });
        expect(res.body).toMatchObject({
            agent_instruction: "check the indemnity",
        });
    });

    it("inherits the parent's project binding", async () => {
        db.rows.chats.push(parentChat({ project_id: "proj-9" }));

        await auth(request(app).post("/chat/create")).send({
            parent_chat_id: "parent-1",
            agent_instruction: "look at this",
        });

        expect(
            db.writes.find((write) => write.table === "chats")?.value,
        ).toMatchObject({ project_id: "proj-9" });
    });

    it("rejects a project_id that contradicts the parent", async () => {
        db.rows.chats.push(parentChat({ project_id: "proj-9" }));

        const res = await auth(request(app).post("/chat/create")).send({
            parent_chat_id: "parent-1",
            agent_instruction: "look at this",
            project_id: "proj-other",
        });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("project_id does not match parent chat");
    });

    it("404s when the parent is not accessible", async () => {
        db.rows.chats.push(parentChat({ user_id: "someone-else" }));

        const res = await auth(request(app).post("/chat/create")).send({
            parent_chat_id: "parent-1",
            agent_instruction: "look at this",
        });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Parent chat not found");
        expect(db.writes).toHaveLength(0);
    });

    it("refuses to nest an agent under an agent", async () => {
        db.rows.chats.push(parentChat(), agentChat());

        const res = await auth(request(app).post("/chat/create")).send({
            parent_chat_id: "agent-1",
            agent_instruction: "and now recurse",
        });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "An agent cannot be assigned its own agents",
        );
        expect(
            db.writes.filter((write) => write.op === "insert"),
        ).toHaveLength(0);
    });

    it(`refuses the ${MAX_ACTIVE_CHAT_AGENTS + 1}th agent on one response`, async () => {
        db.rows.chats.push(parentChat());
        for (let i = 0; i < MAX_ACTIVE_CHAT_AGENTS; i += 1) {
            db.rows.chats.push(agentChat({ id: `agent-${i}` }));
        }

        const res = await auth(request(app).post("/chat/create")).send({
            parent_chat_id: "parent-1",
            agent_instruction: "one too many",
        });

        expect(res.status).toBe(400);
        expect(res.body.detail).toContain(String(MAX_ACTIVE_CHAT_AGENTS));
        expect(
            db.writes.filter((write) => write.op === "insert"),
        ).toHaveLength(0);
    });

    it("still allows the last agent under the cap", async () => {
        db.rows.chats.push(parentChat());
        for (let i = 0; i < MAX_ACTIVE_CHAT_AGENTS - 1; i += 1) {
            db.rows.chats.push(agentChat({ id: `agent-${i}` }));
        }

        const res = await auth(request(app).post("/chat/create")).send({
            parent_chat_id: "parent-1",
            agent_instruction: "just in time",
        });

        expect(res.status).toBe(200);
    });

    it("rejects an assignment with no instruction", async () => {
        db.rows.chats.push(parentChat());

        const res = await auth(request(app).post("/chat/create")).send({
            parent_chat_id: "parent-1",
        });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "agent_instruction must be a non-empty string",
        );
    });

    it("leaves an ordinary create untouched", async () => {
        const res = await auth(request(app).post("/chat/create")).send({});

        expect(res.status).toBe(200);
        expect(
            db.writes.find((write) => write.table === "chats")?.value,
        ).not.toHaveProperty("parent_chat_id");
    });
});

describe("GET /chat — history list", () => {
    it("delegates to the overview RPC, which excludes agents", async () => {
        // The exclusion itself lives in get_chats_overview (asserted against a
        // real database in the migration check); what the route owes is that it
        // asks that function and nothing else.
        const res = await auth(request(app).get("/chat"));
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

describe("GET /chat/:chatId/agents", () => {
    it("returns the parent's agents with a derived status", async () => {
        db.rows.chats.push(
            parentChat(),
            agentChat({ id: "agent-a", created_at: "2026-08-26T10:01:00Z" }),
            agentChat({ id: "agent-b", created_at: "2026-08-26T10:02:00Z" }),
        );
        db.rows.chat_messages.push(
            {
                id: "m1",
                chat_id: "agent-a",
                role: "user",
                content: "seed",
                created_at: "2026-08-26T10:01:01Z",
            },
            {
                id: "m2",
                chat_id: "agent-a",
                role: "assistant",
                content: [{ type: "content", text: "answered" }],
                created_at: "2026-08-26T10:01:02Z",
            },
            {
                id: "m3",
                chat_id: "agent-b",
                role: "user",
                content: "seed",
                created_at: "2026-08-26T10:02:01Z",
            },
        );

        const res = await auth(request(app).get("/chat/parent-1/agents"));

        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "agent-a",
                status: "ready",
                pending_proposals: 0,
            }),
            expect.objectContaining({ id: "agent-b", status: "empty" }),
        ]);
    });

    it("counts each agent's unresolved proposals", async () => {
        db.rows.chats.push(parentChat(), agentChat());
        db.rows.chat_messages.push({
            id: "m1",
            chat_id: "agent-1",
            role: "assistant",
            content: [
                { type: "content", text: "two ideas" },
                {
                    type: "edit_proposal",
                    proposal_id: "p1",
                    target_excerpt: "a",
                    replacement: "b",
                    reason: null,
                    status: "pending",
                },
                {
                    type: "edit_proposal",
                    proposal_id: "p2",
                    target_excerpt: "c",
                    replacement: "d",
                    reason: null,
                    status: "accepted",
                },
            ],
            created_at: "2026-08-26T10:01:02Z",
        });

        const res = await auth(request(app).get("/chat/parent-1/agents"));

        expect(res.body[0]).toMatchObject({
            status: "ready",
            pending_proposals: 1,
        });
    });

    it("is an empty list for a chat with no agents", async () => {
        db.rows.chats.push(parentChat());
        const res = await auth(request(app).get("/chat/parent-1/agents"));
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("404s for a chat the user cannot reach", async () => {
        db.rows.chats.push(parentChat({ user_id: "someone-else" }));
        const res = await auth(request(app).get("/chat/parent-1/agents"));
        expect(res.status).toBe(404);
    });
});

describe("PATCH /chat/:chatId/messages/:messageId", () => {
    const assistantMessage = () => ({
        id: "msg-1",
        chat_id: "parent-1",
        role: "assistant",
        content: [{ type: "content", text: "old wording" }],
        edited_at: null,
        created_at: "2026-08-26T10:00:05Z",
    });

    it("replaces the stored events and stamps edited_at", async () => {
        db.rows.chats.push(parentChat());
        db.rows.chat_messages.push(assistantMessage());

        const res = await auth(
            request(app).patch("/chat/parent-1/messages/msg-1"),
        ).send({ content: [{ type: "content", text: "new wording" }] });

        expect(res.status).toBe(200);
        expect(db.rows.chat_messages[0].content).toEqual([
            { type: "content", text: "new wording" },
        ]);
        expect(db.rows.chat_messages[0].edited_at).toEqual(expect.any(String));
    });

    it("404s for a chat the user cannot reach", async () => {
        db.rows.chats.push(parentChat({ user_id: "someone-else" }));
        db.rows.chat_messages.push(assistantMessage());

        const res = await auth(
            request(app).patch("/chat/parent-1/messages/msg-1"),
        ).send({ content: [{ type: "content", text: "new wording" }] });

        expect(res.status).toBe(404);
        expect(db.rows.chat_messages[0].content).toEqual([
            { type: "content", text: "old wording" },
        ]);
    });

    it("refuses to rewrite a message in another chat", async () => {
        db.rows.chats.push(parentChat());
        db.rows.chat_messages.push(
            assistantMessage(),
            {
                ...assistantMessage(),
                id: "msg-elsewhere",
                chat_id: "other-chat",
            },
        );

        const res = await auth(
            request(app).patch("/chat/parent-1/messages/msg-elsewhere"),
        ).send({ content: [{ type: "content", text: "new wording" }] });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Message not found");
    });

    it("refuses to rewrite a user message", async () => {
        db.rows.chats.push(parentChat());
        db.rows.chat_messages.push({
            id: "msg-user",
            chat_id: "parent-1",
            role: "user",
            content: "what I said",
            created_at: "2026-08-26T10:00:01Z",
        });

        const res = await auth(
            request(app).patch("/chat/parent-1/messages/msg-user"),
        ).send({ content: [{ type: "content", text: "not what I said" }] });

        expect(res.status).toBe(404);
        expect(db.rows.chat_messages[0].content).toBe("what I said");
    });

    it.each([
        [{}, "content must be an array of events"],
        [{ content: "plain text" }, "content must be an array of events"],
        [
            { content: [{ text: "no type" }] },
            "content[0] must be an object with a type",
        ],
    ])("rejects %j", async (body, detail) => {
        db.rows.chats.push(parentChat());
        db.rows.chat_messages.push(assistantMessage());

        const res = await auth(
            request(app).patch("/chat/parent-1/messages/msg-1"),
        ).send(body);

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(detail);
        expect(db.rows.chat_messages[0].content).toEqual([
            { type: "content", text: "old wording" },
        ]);
    });
});

describe("PATCH /chat/:chatId/proposals/:proposalId", () => {
    const withProposal = () => {
        db.rows.chats.push(parentChat(), agentChat());
        db.rows.chat_messages.push({
            id: "m1",
            chat_id: "agent-1",
            role: "assistant",
            content: [
                {
                    type: "edit_proposal",
                    proposal_id: "p1",
                    target_excerpt: "a",
                    replacement: "b",
                    reason: null,
                    status: "pending",
                },
            ],
            created_at: "2026-08-26T10:01:02Z",
        });
    };

    it("marks the proposal resolved in place", async () => {
        withProposal();

        const res = await auth(
            request(app).patch("/chat/agent-1/proposals/p1"),
        ).send({ status: "accepted" });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ proposal_id: "p1", status: "accepted" });
        expect(
            (db.rows.chat_messages[0].content as { status: string }[])[0].status,
        ).toBe("accepted");
    });

    it("rejects an unknown status", async () => {
        withProposal();

        const res = await auth(
            request(app).patch("/chat/agent-1/proposals/p1"),
        ).send({ status: "maybe" });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe('status must be "accepted" or "rejected"');
    });

    it("404s for an unknown proposal", async () => {
        withProposal();

        const res = await auth(
            request(app).patch("/chat/agent-1/proposals/nope"),
        ).send({ status: "rejected" });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Proposal not found");
    });

    it("404s for a chat the user cannot reach", async () => {
        db.rows.chats.push(agentChat({ user_id: "someone-else" }));

        const res = await auth(
            request(app).patch("/chat/agent-1/proposals/p1"),
        ).send({ status: "accepted" });

        expect(res.status).toBe(404);
    });
});

describe("POST /chat — propose_edit gating", () => {
    // The model is explicit because a turn that names none is refused before
    // any gating happens. These cases are about propose_edit, not selection.
    const send = (chatId: string) =>
        auth(request(app).post("/chat")).send({
            chat_id: chatId,
            messages: [{ role: "user", content: "go" }],
            model: "gemini-3-flash-preview",
        });

    it("offers propose_edit and the agent role prompt inside an agent", async () => {
        const chatLib = await import("../../lib/chat");
        db.rows.chats.push(parentChat(), agentChat());

        const res = await send("agent-1");

        expect(res.status).toBe(200);
        const params = runLLMStream.mock.calls[0][0] as {
            routeTools?: { owns: (name: string) => boolean };
            includeAskInputs?: boolean;
        };
        expect(params.routeTools?.owns(PROPOSE_EDIT_TOOL_NAME)).toBe(true);
        expect(params.includeAskInputs).toBe(false);
        const systemPromptExtra = vi.mocked(chatLib.buildMessages).mock
            .calls[0]?.[2] as string;
        expect(systemPromptExtra).toContain("ASSIGNED AGENT ROLE");
        expect(systemPromptExtra).toContain("the indemnity clause");
    });

    it("does not offer it in an ordinary chat", async () => {
        const chatLib = await import("../../lib/chat");
        db.rows.chats.push(parentChat());

        const res = await send("parent-1");

        expect(res.status).toBe(200);
        const params = runLLMStream.mock.calls[0][0] as {
            routeTools?: unknown;
            includeAskInputs?: boolean;
        };
        expect(params.routeTools).toBeUndefined();
        expect(params.includeAskInputs).toBe(true);
        const systemPromptExtra = vi.mocked(chatLib.buildMessages).mock
            .calls[0]?.[2] as string | undefined;
        expect(systemPromptExtra ?? "").not.toContain("ASSIGNED AGENT ROLE");
    });
});
