/** Deterministic provider boundary for full-stack E2E; never calls a live model. */
import http from "node:http";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const textOf = (content) => typeof content === "string"
    ? content : (content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");

// Two scripts, not a model emulator. Unknown chat prompts fail rather than
// returning a plausible answer that could conceal a dropped user message.
function responseContent(body) {
    if (!body.stream) return [{ type: "text", text: "E2E chat" }];
    const prompt = [...body.messages].reverse()
        .filter(message => message.role === "user")
        .map(message => textOf(message.content)).find(Boolean) ?? "";
    const echo = prompt.match(/Reply with exactly: ([^\n]+)/);
    if (echo) return [{ type: "text", text: echo[1].trim() }];
    if (!prompt.includes("Read test.pdf and quote its first line.")) {
        throw new Error("Unexpected chat prompt in E2E provider fixture");
    }
    const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === "tool_result" && block.tool_use_id === "toolu_e2e_read");
    if (result) {
        if (result.is_error || !textOf(result.content).trim()) throw new Error("Document read failed");
        // Echo only what the real tool returned. The PDF's expected text lives in
        // the browser assertion; it is deliberately not supplied by this server.
        const toolText = textOf(result.content);
        // The tool prefixes citation instructions and a fenced filename; its
        // final untrusted-content block is the extracted document body. Echoing
        // the instructions would feed their <CITATIONS> example into the app's
        // citation parser and hide the rest of the answer.
        const source = [...toolText.matchAll(/<untrusted-content\b[^>]*>\n([\s\S]*?)\n<\/untrusted-content\b[^>]*>/g)].at(-1)?.[1] ?? toolText;
        return [{ type: "text", text: `Document tool result:\n\n\`\`\`text\n${source}\n\`\`\`` }];
    }
    const document = textOf(body.system).match(/^- (doc-\d+): (?:<untrusted-content[^>]*>\s*)?test\.pdf(?:\s|<|$)/m);
    if (!document || !body.tools?.some(tool => tool.name === "read_document")) {
        throw new Error("Uploaded test.pdf or read_document missing from provider request");
    }
    return [{ type: "tool_use", id: "toolu_e2e_read", name: "read_document", input: { doc_id: document[1] } }];
}

export function createAnthropicStubServer() {
    return http.createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200).end("ok");
            return;
        }
        if (req.method !== "POST" || req.url !== "/v1/messages") {
            res.writeHead(404).end();
            return;
        }
        let body;
        try {
            let raw = "";
            for await (const chunk of req) raw += chunk;
            body = JSON.parse(raw);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({
                type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" },
            }));
            return;
        }
        let content;
        try {
            if (!body?.model || !Array.isArray(body.messages) || !body.messages.length) {
                throw new Error("Provider request requires model and messages");
            }
            content = responseContent(body);
        } catch (error) {
            console.error(error.message);
            res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({
                type: "error", error: { type: "invalid_request_error", message: error.message },
            }));
            return;
        }
        const stopReason = content[0].type === "tool_use" ? "tool_use" : "end_turn";
        const message = {
            id: "msg_e2e_fixture",
            type: "message",
            role: "assistant",
            model: body.model,
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 20 },
        };
        // Title generation uses a non-streaming completion; chat uses SSE.
        if (!body.stream) {
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(message));
            return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        const block = content[0];
        if (block.type === "tool_use") {
            event("content_block_start", { index: 0, content_block: { ...block, input: {} } });
            event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        } else {
            event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
            for (const text of block.text.match(/.{1,64}/gs)) {
                if (res.destroyed) return;
                event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
                await setTimeout(5);
            }
        }
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
        event("message_stop", {});
        res.end();
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    createAnthropicStubServer().listen(4141, "127.0.0.1", () => {
        console.log("E2E model fixture ready on http://127.0.0.1:4141");
    });
}
