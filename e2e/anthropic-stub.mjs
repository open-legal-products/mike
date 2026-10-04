/** Deterministic provider boundary for full-stack E2E; never calls a live model. */
import http from "node:http";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const FIXTURE_REPLY = "This test document describes a services agreement, including payment and confidentiality obligations.";

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
        const message = {
            id: "msg_e2e_fixture",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: FIXTURE_REPLY }],
            stop_reason: "end_turn",
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
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        for (const text of FIXTURE_REPLY.match(/.{1,16}/g)) {
            if (res.destroyed) return;
            event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
            await setTimeout(5);
        }
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
        event("message_stop", {});
        res.end();
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    createAnthropicStubServer().listen(4141, "127.0.0.1", () => {
        console.log("E2E model fixture ready on http://127.0.0.1:4141");
    });
}
