import http from "node:http";
import { sanitizeTextBlock, stripControls } from "./blocks";
import { createSandboxCore } from "./core";
import { sandboxLimits } from "./limits";
import type {
    BlocksOutcome,
    CheckOutcome,
    PdfOutcome,
    PythonRequest,
    PythonRunOutcome,
    RenderOutcome,
    RenderRequest,
    SandboxCapabilities,
    SandboxClient,
    VisualBlock,
} from "./types";

export const SANDBOX_BODY_LIMIT = 40 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const CAPABILITIES_TTL_MS = 60_000;
// The health probe launches Chromium when the sidecar has not yet.
const HEALTH_TIMEOUT_MS = 15_000;
const TRANSPORT_GRACE_MS = 10_000;

type WireImage = Omit<Extract<VisualBlock, { type: "image" }>, "png"> & { png: string };
type WireBlock = Exclude<VisualBlock, { type: "image" }> | WireImage;
type WireRenderOutcome =
    | { ok: true; bytes?: string; blocks?: WireBlock[]; errors?: string[] }
    | Exclude<RenderOutcome, { ok: true }>;

const encodeBlock = (block: VisualBlock): WireBlock =>
    block.type === "image" ? { ...block, png: block.png.toString("base64") } : block;
// The sidecar's answer is checked like the page's: a bad block is dropped, not thrown on.
const decodeBlock = (block: WireBlock): VisualBlock | null => {
    if (block?.type !== "image") return sanitizeTextBlock(block);
    const { png, widthPx, heightPx, alt } = block;
    return typeof png === "string" && typeof widthPx === "number" && typeof heightPx === "number" && typeof alt === "string"
        ? { type: "image", png: Buffer.from(png, "base64"), widthPx, heightPx, alt: stripControls(alt) }
        : null;
};

export function encodeRenderOutcome(outcome: RenderOutcome): WireRenderOutcome {
    if (!outcome.ok) return outcome;
    if ("bytes" in outcome) return { ok: true, bytes: outcome.bytes.toString("base64") };
    if ("blocks" in outcome) return { ok: true, blocks: outcome.blocks.map(encodeBlock) };
    return outcome;
}

const unavailable: SandboxClient = {
    async runPython() {
        return { ok: false, code: "unavailable" };
    },
    async render() {
        return { ok: false, code: "render_unavailable" };
    },
    async capabilities() {
        return { python: false, render: false };
    },
};

export function socketClient(socketPath: string): SandboxClient {
    const request = <T>(method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> =>
        new Promise((resolve, reject) => {
            const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
            const headers = payload ? { "content-type": "application/json", "content-length": payload.length } : {};
            const req = http.request({ socketPath, path, method, signal, headers }, (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE_BYTES) res.destroy(new Error("response too large"));
                    else chunks.push(chunk);
                });
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
                    } catch (error) {
                        reject(error);
                    }
                });
                res.on("error", reject);
            });
            req.on("error", reject);
            req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
            req.end(payload);
        });

    function render(req: { html: string; format: "pdf" }): Promise<PdfOutcome>;
    function render(req: { html: string; format: "blocks" }): Promise<BlocksOutcome>;
    function render(req: { html: string; format: "check" }): Promise<CheckOutcome>;
    function render(req: RenderRequest): Promise<RenderOutcome>;
    async function render(req: RenderRequest): Promise<RenderOutcome> {
        const { renderTimeoutMs, queueWaitMs } = sandboxLimits();
        let wire: WireRenderOutcome;
        try {
            const timeoutMs = renderTimeoutMs + queueWaitMs + TRANSPORT_GRACE_MS;
            wire = await request<WireRenderOutcome>("POST", "/render", req, timeoutMs);
        } catch {
            return { ok: false, code: "render_unavailable" };
        }
        if (!wire.ok) return wire;
        if (req.format === "pdf") {
            return typeof wire.bytes === "string"
                ? { ok: true, bytes: Buffer.from(wire.bytes, "base64") }
                : { ok: false, code: "render_failed" };
        }
        if (req.format === "blocks") {
            return Array.isArray(wire.blocks)
                ? { ok: true, blocks: wire.blocks.flatMap((block) => decodeBlock(block) ?? []) }
                : { ok: false, code: "render_failed" };
        }
        return { ok: true, errors: Array.isArray(wire.errors) ? wire.errors : [] };
    }

    return {
        async runPython(req: PythonRequest, opts) {
            const { pythonTimeoutMs, queueWaitMs } = sandboxLimits();
            try {
                const timeoutMs = pythonTimeoutMs + queueWaitMs + TRANSPORT_GRACE_MS;
                const outcome = await request<PythonRunOutcome>("POST", "/python", req, timeoutMs, opts?.signal);
                return opts?.signal?.aborted ? { ok: false, code: "timeout" } : outcome;
            } catch {
                return { ok: false, code: opts?.signal?.aborted ? "timeout" : "unavailable" };
            }
        },
        render,
        async capabilities() {
            try {
                return await request<SandboxCapabilities>("GET", "/health", undefined, HEALTH_TIMEOUT_MS);
            } catch {
                return { python: false, render: false };
            }
        },
    };
}

let warned = false;

/**
 * Picks the transport once from the environment. Production refuses the
 * in-process fallback unless SANDBOX_ALLOW_LOCAL=true, because a process
 * that holds secrets should not host Chromium and an interpreter.
 */
export function selectSandboxClient(env: NodeJS.ProcessEnv = process.env): SandboxClient & { shutdown?(): Promise<void> } {
    if (env.SANDBOX_SOCKET) return socketClient(env.SANDBOX_SOCKET);
    if (env.NODE_ENV === "production" && env.SANDBOX_ALLOW_LOCAL !== "true") {
        if (!warned) {
            warned = true;
            console.warn("[sandbox] no SANDBOX_SOCKET and SANDBOX_ALLOW_LOCAL is not true: code analysis and visual export are off");
        }
        return unavailable;
    }
    return createSandboxCore();
}

let selected: ReturnType<typeof selectSandboxClient> | null = null;
let capabilities: { value: SandboxCapabilities; at: number } | null = null;

export function getSandbox(): SandboxClient {
    if (!selected) selected = selectSandboxClient();
    return selected;
}

export async function sandboxCapabilities(): Promise<SandboxCapabilities> {
    if (capabilities && Date.now() - capabilities.at < CAPABILITIES_TTL_MS) return capabilities.value;
    const value = await getSandbox().capabilities();
    // A failed probe is not cached: right after a deploy the sidecar may still be starting.
    if (value.python || value.render) capabilities = { value, at: Date.now() };
    return value;
}

export async function shutdownSandbox(): Promise<void> {
    await selected?.shutdown?.();
    selected = null;
    capabilities = null;
}
