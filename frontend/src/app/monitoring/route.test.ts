// @vitest-environment node
// A route handler: plain Node, no DOM. (jsdom's Blob cannot be read by fetch.)
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ENVELOPE_BYTES } from "@/app/lib/sentryTunnel";
import { GET, POST } from "./route";
import * as route from "./route";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const OWN_DSN = "https://abc123@o777.ingest.us.sentry.io/4242";

function envelope(lines: (string | object)[]): Uint8Array {
    return encoder.encode(
        lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    );
}

function parsedLines(bytes: Uint8Array | null): unknown[] {
    expect(bytes).not.toBeNull();
    return decoder
        .decode(bytes!)
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown);
}

describe("route module", () => {
    it("exports only what Next accepts from a route file", () => {
        expect(Object.keys(route).sort()).toEqual(["GET", "POST", "dynamic", "runtime"]);
    });
});

describe("POST /monitoring", () => {
    const fetchMock = vi.fn();
    const originalEnv = { ...process.env };

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        delete process.env.SENTRY_DISABLED;
        delete process.env.SENTRY_DSN;
        delete process.env.SENTRY_ENVIRONMENT;
        delete process.env.SENTRY_INSTALL;
        delete process.env.NEXT_PUBLIC_SENTRY_DISABLED;
        delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        process.env = { ...originalEnv };
    });

    function post(body: Uint8Array | string, headers: Record<string, string> = {}) {
        return POST(
            new NextRequest("http://localhost:3000/monitoring", {
                method: "POST",
                headers: { "content-type": "application/x-sentry-envelope", ...headers },
                body: typeof body === "string" ? body : decoder.decode(body),
            }),
        );
    }

    it("forwards the rewritten envelope to the runtime DSN and relays the status", async () => {
        process.env.SENTRY_DSN = OWN_DSN;
        process.env.SENTRY_ENVIRONMENT = "production";
        fetchMock.mockResolvedValue(
            new Response("{}", { status: 429, headers: { "retry-after": "60", "x-sentry-rate-limits": "60::" } }),
        );
        const response = await post(
            envelope([{ dsn: "https://client@o1.ingest.sentry.io/1" }, { type: "event" }, { event_id: "c".repeat(32) }]),
        );
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("60");
        expect(response.headers.get("x-sentry-rate-limits")).toBe("60::");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://o777.ingest.us.sentry.io/api/4242/envelope/");
        expect(init.method).toBe("POST");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(parsedLines(new Uint8Array(init.body as ArrayBuffer))).toEqual([
            { dsn: OWN_DSN },
            { type: "event" },
            { event_id: "c".repeat(32), environment: "production" },
        ]);
    });

    it("answers 204 and sends nothing when the deployment is opted out", async () => {
        process.env.SENTRY_DISABLED = "true";
        const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
        expect(response.status).toBe(204);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps a fork's baked opt-out when Compose supplies empty runtime values", async () => {
        process.env.NEXT_PUBLIC_SENTRY_DISABLED = "true";
        process.env.SENTRY_DISABLED = "";
        process.env.SENTRY_DSN = "";
        const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
        expect(response.status).toBe(204);
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await GET().json()).reports).toBe("disabled");
    });

    it("forwards browser reports when runtime settings re-enable a baked-off image", async () => {
        process.env.NEXT_PUBLIC_SENTRY_DISABLED = "true";
        process.env.SENTRY_DISABLED = "false";
        process.env.SENTRY_DSN = OWN_DSN;
        fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
        const response = await post(envelope([{ dsn: "https://placeholder@localhost/1" }, { type: "event" }, {}]));
        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://o777.ingest.us.sentry.io/api/4242/envelope/");
        expect(parsedLines(new Uint8Array(init.body as ArrayBuffer))[0]).toEqual({ dsn: OWN_DSN });
        expect((await GET().json()).reports).toBe("runtime");
    });

    it.each([undefined, "1"])("cancels an oversized stream before reading it all (Content-Length: %s)", async (declared) => {
        let reads = 0;
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                reads += 1;
                controller.enqueue(new Uint8Array(MAX_ENVELOPE_BYTES / 2));
                if (reads === 10) controller.close();
            },
            cancel,
        }, { highWaterMark: 0 });
        const request = new NextRequest("http://localhost:3000/monitoring", {
            method: "POST",
            body,
            headers: declared ? { "content-length": declared } : {},
        });
        expect((await POST(request)).status).toBe(413);
        expect(reads).toBe(3);
        expect(cancel).toHaveBeenCalledOnce();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects oversized, empty and unparseable envelopes without forwarding", async () => {
        expect((await post("", { "content-length": String(MAX_ENVELOPE_BYTES + 1) })).status).toBe(413);
        expect((await post("x".repeat(MAX_ENVELOPE_BYTES + 1))).status).toBe(413);
        expect((await post("")).status).toBe(400);
        expect((await post("not an envelope\n")).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("answers 502 when Sentry is unreachable", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
        expect(response.status).toBe(502);
        warn.mockRestore();
    });

    it("still relays Sentry's 200 when releasing the response stream fails", async () => {
        process.env.SENTRY_DSN = OWN_DSN;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                throw new Error("already closed");
            },
        });
        fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
        expect(response.status).toBe(200);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("answers 413 for an oversized stream even when cancelling it fails", async () => {
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(MAX_ENVELOPE_BYTES + 1));
            },
            cancel() {
                throw new Error("socket gone");
            },
        });
        const request = new NextRequest("http://localhost:3000/monitoring", { method: "POST", body });
        expect((await POST(request)).status).toBe(413);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("names the variable that switched reporting off", async () => {
        process.env.NEXT_PUBLIC_SENTRY_DISABLED = "true";
        process.env.SENTRY_DISABLED = "";
        expect(await GET().json()).toMatchObject({ reports: "disabled", disabledBy: "build" });
        process.env.SENTRY_DISABLED = "true";
        expect(await GET().json()).toMatchObject({ reports: "disabled", disabledBy: "runtime" });
        process.env.SENTRY_DISABLED = "false";
        expect(await GET().json()).toEqual({ reports: "default", see: expect.any(String) });
    });

    it("answers GET with the rule that decides the destination, never the DSN", async () => {
        process.env.SENTRY_DSN = OWN_DSN;
        const response = GET();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = (await response.json()) as { reports: string };
        expect(body.reports).toBe("runtime");
        expect(JSON.stringify(body)).not.toContain("abc123");
        process.env.SENTRY_DISABLED = "true";
        expect(((await GET().json()) as { reports: string }).reports).toBe("disabled");
    });
});
