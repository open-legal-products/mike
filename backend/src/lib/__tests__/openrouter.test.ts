import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "../llm/providers";

function streamResponse(chunks: unknown[]): Response {
    const body = `${chunks
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("")}data: [DONE]\n\n`;
    return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
}

function functionTool(
    name: string,
    parameters: Record<string, unknown> = { type: "object" },
) {
    return {
        type: "function" as const,
        function: { name, description: `${name} test tool`, parameters },
    };
}

function messagesStreamResponse(model: string, text: string): Response {
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 3, output_tokens: 0 },
            },
        },
        {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: null },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
        },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
        },
        { type: "message_stop" },
    ];
    const body = events
        .map(
            (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
    return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
}

function messagesToolStreamResponse(model: string): Response {
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg_tool",
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 3, output_tokens: 0 },
            },
        },
        {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "tool_use",
                id: "tool_1",
                name: "lookup",
                input: {},
            },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: {
                type: "input_json_delta",
                partial_json: '{"query":"contract"}',
            },
        },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 4 },
        },
        { type: "message_stop" },
    ];
    const body = events
        .map(
            (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
    return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
}

describe("OpenRouter LLM adapter", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("uses the saved key and removes the internal model namespace", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "A short title",
                            },
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await completeWithProvider({
            model: "openrouter/openai/gpt-5.4",
            user: "Title this",
            apiKeys: { openrouter: "or-user-key" },
        });

        expect(result).toBe("A short title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer or-user-key",
        );
        expect(JSON.parse(String(init.body))).toMatchObject({
            model: "openai/gpt-5.4",
        });
    });

    it("streams reasoning and content and continues after a tool call", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                streamResponse([
                    {
                        choices: [
                            {
                                delta: {
                                    reasoning: "Checking",
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call-1",
                                            type: "function",
                                            function: {
                                                name: "lookup",
                                                arguments:
                                                    '{"term":"contract"}',
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ]),
            )
            .mockResolvedValueOnce(
                streamResponse([{ choices: [{ delta: { content: "Done" } }] }]),
            );
        vi.stubGlobal("fetch", fetchMock);
        const onReasoningDelta = vi.fn();
        const onReasoningBlockEnd = vi.fn();
        const onContentDelta = vi.fn();
        const onToolCallStart = vi.fn();
        const runTools = vi
            .fn()
            .mockResolvedValue([{ tool_use_id: "call-1", content: "result" }]);

        const result = await streamWithProvider({
            model: "openrouter/anthropic/claude-sonnet-4.5",
            systemPrompt: "Help",
            messages: [{ role: "user", content: "Review" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "lookup",
                        description: "Look something up",
                        parameters: { type: "object" },
                    },
                },
            ],
            apiKeys: { openrouter: "or-user-key" },
            reasoning: "high",
            callbacks: {
                onReasoningDelta,
                onReasoningBlockEnd,
                onContentDelta,
                onToolCallStart,
            },
            runTools,
        });

        expect(result.fullText).toBe("Done");
        expect(onReasoningDelta).toHaveBeenCalledWith("Checking");
        expect(onReasoningBlockEnd).toHaveBeenCalledOnce();
        expect(onContentDelta).toHaveBeenCalledWith("Done");
        expect(onToolCallStart).toHaveBeenCalledWith({
            id: "call-1",
            name: "lookup",
            input: { term: "contract" },
        });
        expect(runTools).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const secondBody = JSON.parse(
            String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
        );
        expect(secondBody.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ role: "assistant" }),
                expect.objectContaining({
                    role: "tool",
                    tool_call_id: "call-1",
                    content: "result",
                }),
            ]),
        );
    });

    it("fails the stream instead of executing a tool with truncated arguments", async () => {
        // The upstream connection died mid-arguments: the JSON fragment can
        // never parse. Coercing it to {} would EXECUTE a side-effecting tool
        // with empty input; the stream must error like a mid-stream {"error"}.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                streamResponse([
                    {
                        choices: [
                            {
                                delta: {
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call-1",
                                            type: "function",
                                            function: {
                                                name: "delete_document",
                                                arguments: '{"term":"contr',
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ]),
            ),
        );
        const runTools = vi.fn();

        await expect(
            streamWithProvider({
                model: "openrouter/anthropic/claude-sonnet-4.5",
                systemPrompt: "Help",
                messages: [{ role: "user", content: "Review" }],
                tools: [functionTool("delete_document")],
                apiKeys: { openrouter: "or-user-key" },
                runTools,
            }),
        ).rejects.toThrow(/malformed JSON arguments .* "delete_document"/);
        expect(runTools).not.toHaveBeenCalled();
    });

    it("fails the stream when it dies before any argument bytes arrive", async () => {
        // The name delta landed, then the connection dropped: no arguments at
        // all, no finish_reason, no [DONE]. Indistinguishable by content from
        // a parameter-less tool call, so the CLEAN-TERMINATION signal is what
        // separates them — without it, "" must not be coerced to {}.
        const body = `data: ${JSON.stringify({
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call-1",
                                type: "function",
                                function: { name: "delete_document" },
                            },
                        ],
                    },
                },
            ],
        })}\n\n`;
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(body, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                }),
            ),
        );
        const runTools = vi.fn();

        await expect(
            streamWithProvider({
                model: "openrouter/anthropic/claude-sonnet-4.5",
                systemPrompt: "Help",
                messages: [{ role: "user", content: "Review" }],
                tools: [functionTool("delete_document")],
                apiKeys: { openrouter: "or-user-key" },
                runTools,
            }),
        ).rejects.toThrow(/ended before any arguments .* "delete_document"/);
        expect(runTools).not.toHaveBeenCalled();
    });

    it("runs a parameter-less tool with {} when the stream terminated cleanly", async () => {
        // streamResponse appends [DONE], so the empty arguments string here is
        // a real parameter-less call and must still execute.
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                streamResponse([
                    {
                        choices: [
                            {
                                delta: {
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call-1",
                                            type: "function",
                                            function: { name: "list_docs" },
                                        },
                                    ],
                                },
                                finish_reason: "tool_calls",
                            },
                        ],
                    },
                ]),
            )
            .mockResolvedValueOnce(
                streamResponse([{ choices: [{ delta: { content: "Done" } }] }]),
            );
        vi.stubGlobal("fetch", fetchMock);
        const runTools = vi
            .fn()
            .mockResolvedValue([{ tool_use_id: "call-1", content: "[]" }]);

        const result = await streamWithProvider({
            model: "openrouter/anthropic/claude-sonnet-4.5",
            systemPrompt: "Help",
            messages: [{ role: "user", content: "List them" }],
            tools: [functionTool("list_docs")],
            apiKeys: { openrouter: "or-user-key" },
            runTools,
        });

        expect(result.fullText).toBe("Done");
        expect(runTools).toHaveBeenCalledWith([
            { id: "call-1", name: "list_docs", input: {} },
        ]);
    });

    it("processes a final SSE line that arrives without a trailing newline", async () => {
        // Some proxies close the stream mid-line; the residual buffer still
        // holds the last delta and must be flushed, not dropped.
        const body =
            `data: ${JSON.stringify({
                choices: [{ delta: { content: "Hello " } }],
            })}\n\n` +
            `data: ${JSON.stringify({
                choices: [{ delta: { content: "world" } }],
            })}`;
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(body, {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                }),
            ),
        );
        const onContentDelta = vi.fn();

        const result = await streamWithProvider({
            model: "openrouter/anthropic/claude-sonnet-4.5",
            systemPrompt: "Help",
            messages: [{ role: "user", content: "Say hello" }],
            apiKeys: { openrouter: "or-user-key" },
            callbacks: { onContentDelta },
        });

        expect(result.fullText).toBe("Hello world");
        expect(onContentDelta).toHaveBeenLastCalledWith("world");
    });
});

describe("OrcaRouter LLM adapter", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        delete process.env.ORCAROUTER_BASE_URL;
        delete process.env.ORCAROUTER_API_KEY;
    });

    it("uses the saved key, endpoint, and unprefixed model ID", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: "An Orca title" } }],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await completeWithProvider({
            model: "orcarouter/deepseek/deepseek-v4-flash-free",
            user: "Title this",
            apiKeys: { orcarouter: "orca-user-key" },
        });

        expect(result).toBe("An Orca title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://api.orcarouter.ai/v1/chat/completions");
        expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer orca-user-key",
        );
        // OpenRouter-only attribution headers must not leak to other routers.
        expect(init.headers).not.toHaveProperty("X-Title");
        expect(JSON.parse(String(init.body))).toMatchObject({
            model: "deepseek/deepseek-v4-flash-free",
        });
    });

    it("names OrcaRouter when no key is configured", async () => {
        delete process.env.ORCAROUTER_API_KEY;
        await expect(
            completeWithProvider({
                model: "orcarouter/deepseek/deepseek-v4-flash-free",
                user: "Title this",
            }),
        ).rejects.toThrow(
            "OrcaRouter API key is not configured. Set ORCAROUTER_API_KEY",
        );
    });
});

describe("Vercel AI Gateway LLM adapter", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("uses the Vercel key, endpoint, and unprefixed model ID", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    content: [{ type: "text", text: "A Vercel title" }],
                    finishReason: "stop",
                    usage: {
                        inputTokens: {
                            total: 2,
                            noCache: 2,
                            cacheRead: 0,
                            cacheWrite: 0,
                        },
                        outputTokens: { total: 3, text: 3, reasoning: 0 },
                    },
                    warnings: [],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await completeWithProvider({
            model: "vercel/openai/gpt-5.4",
            user: "Title this",
            apiKeys: { vercel: "vercel-user-key" },
        });

        expect(result).toBe("A Vercel title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/language-model");
        const headers = new Headers(init.headers);
        expect(headers.get("authorization")).toBe("Bearer vercel-user-key");
        expect(headers.get("ai-language-model-id")).toBe("openai/gpt-5.4");
        expect(headers.get("ai-language-model-streaming")).toBe("false");
        expect(headers.get("x-title")).toBeNull();
    });
});

describe("OpenCode Go LLM adapter", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("uses the OpenCode Go key, endpoint, and unprefixed model ID", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: "An OpenCode title" } }],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await completeWithProvider({
            model: "opencode-go/glm-5",
            user: "Title this",
            apiKeys: { "opencode-go": "oc-user-key" },
        });

        expect(result).toBe("An OpenCode title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
        expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer oc-user-key",
        );
        // OpenRouter-only attribution headers must not leak to other routers.
        expect(init.headers).not.toHaveProperty("X-Title");
        expect(JSON.parse(String(init.body))).toMatchObject({ model: "glm-5" });
    });

    it("names OpenCode Go when no key is configured", async () => {
        await expect(
            completeWithProvider({
                model: "opencode-go/glm-5",
                user: "Title this",
            }),
        ).rejects.toThrow(
            "OpenCode Go API key is not configured. Set OPENCODE_API_KEY",
        );
    });

    it("uses the Messages endpoint for Qwen and MiniMax models", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    model: "qwen3.8-max",
                    content: [{ type: "text", text: "A Qwen title" }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: 3, output_tokens: 4 },
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await completeWithProvider({
            model: "opencode-go/qwen3.8-max",
            user: "Title this",
            apiKeys: { "opencode-go": "oc-user-key" },
        });

        expect(result).toBe("A Qwen title");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://opencode.ai/zen/go/v1/messages");
        expect(new Headers(init.headers).get("x-api-key")).toBe("oc-user-key");
        expect(JSON.parse(String(init.body))).toMatchObject({
            model: "qwen3.8-max",
            max_tokens: 512,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "Title this" }],
                },
            ],
        });
    });

    it("streams Messages models through the Anthropic-compatible adapter", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(messagesStreamResponse("minimax-m3", "Hello"));
        vi.stubGlobal("fetch", fetchMock);
        const deltas: string[] = [];

        const result = await streamWithProvider({
            model: "opencode-go/minimax-m3",
            systemPrompt: "Be concise",
            messages: [{ role: "user", content: "Hello" }],
            apiKeys: { "opencode-go": "oc-user-key" },
            reasoning: "high",
            callbacks: { onContentDelta: (delta) => deltas.push(delta) },
        });

        expect(result.fullText).toBe("Hello");
        expect(deltas).toEqual(["Hello"]);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://opencode.ai/zen/go/v1/messages");
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
            model: "minimax-m3",
            system: [{ type: "text", text: "Be concise" }],
            stream: true,
        });
        expect(body).not.toHaveProperty("thinking");
        expect(body).not.toHaveProperty("output_config");
    });

    it("preserves the Messages tool-use loop for Qwen and MiniMax", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(messagesToolStreamResponse("qwen3.8-max"))
            .mockResolvedValueOnce(
                messagesStreamResponse("qwen3.8-max", "Found it"),
            );
        vi.stubGlobal("fetch", fetchMock);
        const runTools = vi
            .fn()
            .mockResolvedValue([
                { tool_use_id: "tool_1", content: "Contract result" },
            ]);

        const result = await streamWithProvider({
            model: "opencode-go/qwen3.8-max",
            systemPrompt: "Use tools",
            messages: [{ role: "user", content: "Find the contract" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "lookup",
                        description: "Look up a document",
                        parameters: {
                            type: "object",
                            properties: { query: { type: "string" } },
                            required: ["query"],
                        },
                    },
                },
            ],
            runTools,
            apiKeys: { "opencode-go": "oc-user-key" },
        });

        expect(result.fullText).toBe("Found it");
        expect(runTools).toHaveBeenCalledWith([
            {
                id: "tool_1",
                name: "lookup",
                input: { query: "contract" },
            },
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const secondBody = JSON.parse(
            String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
        );
        expect(secondBody.messages).toEqual([
            {
                role: "user",
                content: [{ type: "text", text: "Find the contract" }],
            },
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: "tool_1",
                        name: "lookup",
                        input: { query: "contract" },
                    },
                ],
            },
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "tool_1",
                        content: "Contract result",
                    },
                ],
            },
        ]);
    });

    it("rejects models that require an unsupported protocol before sending a request", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            completeWithProvider({
                model: "opencode-go/gpt-5.6-luna",
                user: "Title this",
                apiKeys: { "opencode-go": "oc-user-key" },
            }),
        ).rejects.toThrow(
            "OpenCode Go model gpt-5.6-luna requires a protocol Mike does not support yet",
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
