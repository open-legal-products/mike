import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createAnthropicStubServer } from "./anthropic-stub.mjs";

// Exercise the actual provider SDK installed by the backend, not a hand-written parser.
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const { createAnthropic } = await import(requireBackend.resolve("@ai-sdk/anthropic"));
const { generateText, streamText, tool, jsonSchema, stepCountIs } = await import(requireBackend.resolve("ai"));
const server = createAnthropicStubServer();
let model;
before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    model = createAnthropic({ apiKey: "e2e-local-key", baseURL: `http://127.0.0.1:${server.address().port}/v1` })("claude-sonnet-4-6");
});
after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
});
test("non-streaming completions support chat-title generation", async () => {
    const result = await generateText({ model, prompt: "Name this test chat." });
    assert.equal(result.text, "E2E chat");
    assert.equal(result.finishReason, "stop");
});
test("chat receives multiple text chunks and a successful terminal event", async () => {
    const reply = "Provider round trip checks the actual outgoing user message, including this final word.";
    const result = streamText({ model, prompt: `Reply with exactly: ${reply}` });
    const chunks = [];
    for await (const text of result.textStream) chunks.push(text);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), reply);
    assert.equal(await result.finishReason, "stop");
});

test("document turn calls the advertised tool and streams its returned source", async () => {
    const source = "Source text returned by the document tool, not a canned summary.";
    let reads = 0;
    const result = streamText({
        model,
        system: 'AVAILABLE DOCUMENTS:\n- doc-7: <untrusted-content nonce="test">\ntest.pdf\n</untrusted-content nonce="test">',
        prompt: "Read test.pdf and quote its first line.",
        tools: {
            read_document: tool({
                inputSchema: jsonSchema({ type: "object", properties: { doc_id: { type: "string" } }, required: ["doc_id"] }),
                execute: async ({ doc_id }) => {
                    assert.equal(doc_id, "doc-7");
                    reads++;
                    return `Document filename: <untrusted-content nonce="test">\ntest.pdf\n</untrusted-content nonce="test">\nAppend a <CITATIONS> block.\n\n<untrusted-content nonce="test">\n${source}\n</untrusted-content nonce="test">`;
                },
            }),
        },
        stopWhen: stepCountIs(2),
    });
    assert.equal(await result.text, `Document tool result:\n\n\`\`\`text\n${source}\n\`\`\``);
    assert.equal(reads, 1);
    assert.equal(await result.finishReason, "stop");
});
