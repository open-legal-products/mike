// The sandbox sidecar: the same image as the API, run with no network and no
// secrets, reached by the backend over a unix socket. It only forwards to the
// sandbox core in lib/sandbox.
import http from "node:http";
import { chmodSync, unlinkSync } from "node:fs";
import { safeError } from "../lib/safeError";
import {
    SANDBOX_BODY_LIMIT,
    createSandboxCore,
    encodeRenderOutcome,
    type RenderFormat,
    type SandboxCore,
} from "../lib/sandbox";

function readJson(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > SANDBOX_BODY_LIMIT) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

const isRenderFormat = (value: unknown): value is RenderFormat => value === "pdf" || value === "blocks" || value === "check";

export function startSandboxServer(socketPath: string, core: SandboxCore): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        try {
            if (req.method === "GET" && req.url === "/health") return send(200, await core.capabilities());
            if (req.method === "POST" && req.url === "/python") {
                const body = await readJson(req);
                if (!isObject(body) || typeof body.code !== "string" || !Array.isArray(body.docs)) {
                    return send(400, { ok: false, code: "crashed" });
                }
                return send(200, await core.runPython({ code: body.code, docs: body.docs }));
            }
            if (req.method === "POST" && req.url === "/render") {
                const body = await readJson(req);
                if (!isObject(body) || typeof body.html !== "string" || !isRenderFormat(body.format)) {
                    return send(400, { ok: false, code: "render_failed" });
                }
                return send(200, encodeRenderOutcome(await core.render({ html: body.html, format: body.format })));
            }
            send(404, { error: "not found" });
        } catch {
            send(400, { error: "bad request" });
        }
    });
    if (!socketPath.startsWith("\\\\.\\pipe\\")) {
        try {
            unlinkSync(socketPath);
        } catch {
            /* no stale socket */
        }
    }
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            // The API container connects as a different user.
            if (!socketPath.startsWith("\\\\.\\pipe\\")) chmodSync(socketPath, 0o666);
            resolve(server);
        });
    });
}

if (require.main === module) {
    const socketPath = process.env.SANDBOX_SOCKET;
    if (!socketPath) {
        console.error("[sandbox] SANDBOX_SOCKET is not set");
        process.exit(1);
    }
    const core = createSandboxCore();
    startSandboxServer(socketPath, core)
        .then((server) => {
            console.log(`[sandbox] listening on ${socketPath}`);
            const stop = () => {
                server.close();
                void core.shutdown().finally(() => process.exit(0));
            };
            process.on("SIGTERM", stop);
            process.on("SIGINT", stop);
        })
        .catch((error) => {
            console.error("[sandbox] failed to start", safeError(error));
            process.exit(1);
        });
}
