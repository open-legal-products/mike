import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    completeClaudeCode,
    serializeClaudeCodePrompt,
    streamClaudeCode,
} from "../llm/claudeCode";
import { providerForModel, resolveModel } from "../llm/models";
import { hasApiKeyForModel, titleModelForChat } from "../modelSelection";

type Handler = (request: unknown) => Promise<unknown>;

/**
 * Fake Agent SDK: `script` receives the options passed to query() plus the
 * registered MCP handlers and yields SDK messages.
 */
function fakeSdk(
    script: (ctx: {
        options: Record<string, any>;
        callTool: (name: string, args: unknown, meta?: unknown) => Promise<any>;
        listTools: () => Promise<any>;
    }) => AsyncGenerator<Record<string, unknown>>,
) {
    const handlers = new Map<string, Handler>();
    const close = vi.fn();
    const captured: Record<string, any>[] = [];
    const sdk = {
        createSdkMcpServer: vi.fn(({ name }: { name: string }) => ({
            type: "sdk",
            name,
            instance: {
                server: {
                    registerCapabilities: vi.fn(),
                    setRequestHandler: (schema: any, handler: Handler) => {
                        handlers.set(schema.shape.method.value, handler);
                    },
                },
            },
        })),
        query: vi.fn(({ options }: { options: Record<string, any> }) => {
            captured.push(options);
            const generator = script({
                options,
                callTool: (name, args, meta) =>
                    handlers.get("tools/call")!({
                        method: "tools/call",
                        params: { name, arguments: args, _meta: meta },
                    }),
                listTools: () =>
                    handlers.get("tools/list")!({ method: "tools/list" }),
            });
            return Object.assign(generator, { close });
        }),
    };
    return { sdk: sdk as any, close, captured };
}

const textDelta = (text: string) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
    },
});

const success = (result = "") => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
});

const tool = {
    type: "function" as const,
    function: {
        name: "read_document",
        description: "Read a document",
        parameters: {
            type: "object",
            properties: { doc_id: { type: "string" } },
        },
    },
};

beforeEach(() => {
    vi.stubEnv("CLAUDE_CODE_ENABLED", "true");
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("claude-code model catalog", () => {
    it("routes claude-code ids to their own keyless provider", () => {
        expect(providerForModel("claude-code/sonnet")).toBe("claude-code");
        expect(providerForModel("claude-sonnet-5")).toBe("claude");
        expect(resolveModel("claude-code/opus", "")).toBe("claude-code/opus");
        expect(resolveModel("claude-code/unknown", "")).toBe("");
        expect(hasApiKeyForModel("claude-code/opus", {})).toBe(true);
        expect(titleModelForChat("claude-code/opus")).toBe("claude-code/haiku");
    });

    it("is unavailable when the server has not enabled it", () => {
        vi.stubEnv("CLAUDE_CODE_ENABLED", "");
        expect(hasApiKeyForModel("claude-code/opus", {})).toBe(false);
    });
});

describe("serializeClaudeCodePrompt", () => {
    it("passes a single user message through unchanged", () => {
        expect(
            serializeClaudeCodePrompt([{ role: "user", content: "Hello" }]),
        ).toBe("Hello");
    });

    it("replays earlier turns ahead of the latest user message", () => {
        const prompt = serializeClaudeCodePrompt([
            { role: "user", content: "First" },
            { role: "assistant", content: "Reply" },
            { role: "user", content: "Second" },
        ]);
        expect(prompt).toContain('<turn role="user">\nFirst\n</turn>');
        expect(prompt).toContain('<turn role="assistant">\nReply\n</turn>');
        expect(prompt.endsWith("Second")).toBe(true);
    });
});

describe("streamClaudeCode", () => {
    it("maps stream events to callbacks and routes tool calls to runTools", async () => {
        const { sdk, close, captured } = fakeSdk(async function* (ctx) {
            const listed = await ctx.listTools();
            expect(listed.tools[0]).toMatchObject({
                name: "read_document",
                inputSchema: tool.function.parameters,
            });
            yield {
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "thinking", thinking: "" },
                },
            };
            yield {
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "thinking_delta", thinking: "Hmm" },
                },
            };
            yield {
                type: "stream_event",
                parent_tool_use_id: null,
                event: { type: "content_block_stop", index: 0 },
            };
            yield {
                type: "assistant",
                parent_tool_use_id: null,
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_1",
                            name: "mcp__mike__read_document",
                            input: { doc_id: "d1" },
                        },
                    ],
                },
            };
            const toolResult = await ctx.callTool("read_document", {
                doc_id: "d1",
            });
            expect(toolResult.content[0].text).toBe("Delaware law");
            yield textDelta("Governed by ");
            yield textDelta("Delaware law.");
            yield success("Governed by Delaware law.");
        });

        const onContentDelta = vi.fn();
        const onReasoningDelta = vi.fn();
        const onReasoningBlockEnd = vi.fn();
        const onToolCallStart = vi.fn();
        const runTools = vi.fn(async (calls: any[]) =>
            calls.map((c) => ({ tool_use_id: c.id, content: "Delaware law" })),
        );

        const result = await streamClaudeCode(
            {
                model: "claude-code/sonnet",
                systemPrompt: "SYSTEM",
                messages: [{ role: "user", content: "Governing law?" }],
                tools: [tool],
                runTools,
                reasoning: "high",
                maxIterations: 7,
                callbacks: {
                    onContentDelta,
                    onReasoningDelta,
                    onReasoningBlockEnd,
                    onToolCallStart,
                },
            },
            sdk,
        );

        expect(result.fullText).toBe("Governed by Delaware law.");
        expect(onReasoningDelta).toHaveBeenCalledWith("Hmm");
        expect(onReasoningBlockEnd).toHaveBeenCalledTimes(1);
        expect(onToolCallStart).toHaveBeenCalledWith({
            id: "toolu_1",
            name: "read_document",
            input: { doc_id: "d1" },
        });
        expect(runTools).toHaveBeenCalledWith([
            { id: "toolu_1", name: "read_document", input: { doc_id: "d1" } },
        ]);
        expect(close).toHaveBeenCalled();

        const options = captured[0];
        expect(options).toMatchObject({
            model: "sonnet",
            systemPrompt: "SYSTEM",
            tools: [],
            settingSources: [],
            allowedTools: ["mcp__mike__read_document"],
            maxTurns: 7,
            thinking: { type: "adaptive" },
            effort: "high",
        });
        expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("rethrows a runTools failure such as an ask_inputs pause", async () => {
        class Pause extends Error {}
        const { sdk } = fakeSdk(async function* (ctx) {
            await ctx.callTool("read_document", {}).catch(() => undefined);
            // The CLI reports the aborted run as an error after the tool fails.
            yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["aborted"] };
        });

        await expect(
            streamClaudeCode(
                {
                    model: "claude-code/sonnet",
                    systemPrompt: "",
                    messages: [{ role: "user", content: "Draft" }],
                    tools: [tool],
                    runTools: async () => {
                        throw new Pause("paused");
                    },
                },
                sdk,
            ),
        ).rejects.toBeInstanceOf(Pause);
    });

    it("keeps partial text when the turn limit is reached", async () => {
        const { sdk } = fakeSdk(async function* () {
            yield textDelta("Partial");
            yield { type: "result", subtype: "error_max_turns", is_error: true, errors: [] };
        });
        const result = await streamClaudeCode(
            {
                model: "claude-code/sonnet",
                systemPrompt: "",
                messages: [{ role: "user", content: "Hi" }],
            },
            sdk,
        );
        expect(result.fullText).toBe("Partial");
    });

    it("surfaces an AbortError when the caller aborts", async () => {
        const controller = new AbortController();
        const { sdk } = fakeSdk(async function* () {
            yield textDelta("Hi");
            controller.abort();
            throw new Error("Claude Code process aborted by user");
        });
        await expect(
            streamClaudeCode(
                {
                    model: "claude-code/sonnet",
                    systemPrompt: "",
                    messages: [{ role: "user", content: "Hi" }],
                    abortSignal: controller.signal,
                },
                sdk,
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("refuses to run when disabled", async () => {
        vi.stubEnv("CLAUDE_CODE_ENABLED", "false");
        const { sdk } = fakeSdk(async function* () {});
        await expect(
            streamClaudeCode(
                { model: "claude-code/sonnet", systemPrompt: "", messages: [] },
                sdk,
            ),
        ).rejects.toThrow(/CLAUDE_CODE_ENABLED/);
    });
});

describe("completeClaudeCode", () => {
    it("returns the result text without tools or thinking", async () => {
        const { sdk, captured } = fakeSdk(async function* () {
            yield success("Lease Review");
        });
        await expect(
            completeClaudeCode(
                { model: "claude-code/haiku", systemPrompt: "Title", user: "x" },
                sdk,
            ),
        ).resolves.toBe("Lease Review");
        expect(captured[0]).toMatchObject({
            model: "haiku",
            maxTurns: 1,
            tools: [],
            thinking: { type: "disabled" },
        });
        expect(captured[0].mcpServers).toBeUndefined();
    });

    it("throws on an error result", async () => {
        const { sdk } = fakeSdk(async function* () {
            yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Not logged in"] };
        });
        await expect(
            completeClaudeCode({ model: "claude-code/haiku", user: "x" }, sdk),
        ).rejects.toThrow(/Not logged in/);
    });
});
