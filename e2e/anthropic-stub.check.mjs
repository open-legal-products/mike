import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createAnthropicStubServer, FIXTURE_REPLY } from "./anthropic-stub.mjs";

// Exercise the actual provider SDK installed by the backend, not a hand-written parser.
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const { createAnthropic } = await import(requireBackend.resolve("@ai-sdk/anthropic"));
const { generateText, streamText } = await import(requireBackend.resolve("ai"));
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
    assert.equal(result.text, FIXTURE_REPLY);
    assert.equal(result.finishReason, "stop");
});
test("chat receives multiple text chunks and a successful terminal event", async () => {
    const result = streamText({ model, prompt: "Summarize the test document." });
    const chunks = [];
    for await (const text of result.textStream) chunks.push(text);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), FIXTURE_REPLY);
    assert.equal(await result.finishReason, "stop");
});
