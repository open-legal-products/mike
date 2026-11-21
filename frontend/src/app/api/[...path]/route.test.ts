import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { upstreamReportWindow } from "./upstreamFailure";

const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/errorReporting', () => ({ reportError }));
const fetchMock = vi.fn();
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

async function readBody(response: Response) {
    return new TextDecoder().decode(
        await new Response(response.body).arrayBuffer(),
    );
}

describe("same-origin API gateway", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        reportError.mockReset();
        upstreamReportWindow.reset();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("forwards cookies, origin, query parameters, and encoded path segments", async () => {
        const upstreamHeaders = new Headers({
            "content-type": "application/json",
        });
        upstreamHeaders.append(
            "set-cookie",
            "__Host-mike-session=one; Path=/; Secure; HttpOnly",
        );
        upstreamHeaders.append(
            "set-cookie",
            "__Host-mike-session.1=two; Path=/; Secure; HttpOnly",
        );
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: upstreamHeaders,
            }),
        );
        const request = new NextRequest(
            "https://app.example.test/api/projects/a%2Fb?view=full",
            {
                headers: {
                    cookie: "__Host-mike-session=incoming",
                    origin: "https://app.example.test",
                },
            },
        );

        const response = await GET(request, context(["projects", "a/b"]));

        const [upstreamUrl, init] = fetchMock.mock.calls[0] as [
            URL,
            RequestInit,
        ];
        expect(upstreamUrl.toString()).toBe(
            "http://localhost:3001/projects/a%2Fb?view=full",
        );
        const forwardedHeaders = new Headers(init.headers);
        expect(forwardedHeaders.get("cookie")).toBe(
            "__Host-mike-session=incoming",
        );
        expect(forwardedHeaders.get("origin")).toBe("https://app.example.test");
        expect(forwardedHeaders.get("host")).toBeNull();
        expect(forwardedHeaders.get("x-forwarded-host")).toBe(
            "app.example.test",
        );
        expect(response.headers.get("set-cookie")).toContain(
            "__Host-mike-session=one",
        );
        expect(response.headers.get("set-cookie")).toContain(
            "__Host-mike-session.1=two",
        );
    });

    it("removes response hop-by-hop headers, including connection-nominated fields", async () => {
        fetchMock.mockResolvedValue(new Response("body", { headers: {
            connection: "keep-alive, x-internal-socket", "keep-alive": "timeout=5",
            "x-internal-socket": "private", "transfer-encoding": "chunked",
            trailer: "x-checksum", "proxy-authenticate": "private", "content-type": "text/plain",
        } }));
        const response = await GET(new NextRequest("https://app.example.test/api/projects"), context(["projects"]));
        for (const name of ["connection", "keep-alive", "x-internal-socket", "transfer-encoding", "trailer", "proxy-authenticate"]) {
            expect(response.headers.has(name)).toBe(false);
        }
        expect(response.headers.get("content-type")).toBe("text/plain");
        expect(await response.text()).toBe("body");
    });

    it("streams request and SSE response bodies without buffering", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("data: first\n\n"));
                controller.enqueue(encoder.encode("data: second\n\n"));
                controller.close();
            },
        });
        fetchMock.mockResolvedValue(
            new Response(stream, {
                headers: { "content-type": "text/event-stream" },
            }),
        );
        const request = new NextRequest("https://app.example.test/api/chat", {
            method: "POST",
            body: JSON.stringify({ message: "hello" }),
            headers: { "content-type": "application/json" },
        });

        const response = await POST(request, context(["chat"]));

        const init = fetchMock.mock.calls[0][1] as RequestInit & {
            duplex?: string;
        };
        expect(init.body).toBe(request.body);
        expect(init.duplex).toBe("half");
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        await expect(readBody(response)).resolves.toBe(
            "data: first\n\ndata: second\n\n",
        );
    });

    // undici refuses some hop-by-hop request headers outright, and the
    // gateway answered 502 for every such request: `Expect` throws
    // NotSupportedError (MIKE-FRONTEND-3M), and `keep-alive`, `upgrade` and
    // `transfer-encoding` throw InvalidArgumentError (MIKE-FRONTEND-4B, -4A).
    it("does not forward hop-by-hop headers", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        const request = new NextRequest("https://app.example.test/api/documents", {
            method: "POST",
            body: "{}",
            headers: {
                expect: "100-continue",
                "keep-alive": "timeout=5",
                te: "trailers",
                trailer: "x-checksum",
                upgrade: "h2c",
                "transfer-encoding": "chunked",
                "proxy-authorization": "Basic cHJveHk6c2VjcmV0",
                connection: "keep-alive, x-hop",
                "x-hop": "1",
                "content-type": "application/json",
            },
        });

        await POST(request, context(["documents"]));

        const forwarded = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
        for (const name of ["expect", "keep-alive", "te", "trailer", "upgrade", "transfer-encoding", "proxy-authorization", "connection", "x-hop"]) {
            expect(forwarded.has(name), name).toBe(false);
        }
        expect(forwarded.get("content-type")).toBe("application/json");
    });

    it("aborts the backend request when the client goes away", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        const request = new NextRequest("https://app.example.test/api/health");

        await GET(request, context(["health"]));

        expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(request.signal);
    });

    it("does not report a backend request the client aborted", async () => {
        const client = new AbortController();
        fetchMock.mockImplementation(async () => {
            client.abort();
            throw new DOMException("This operation was aborted", "AbortError");
        });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const request = new NextRequest("https://app.example.test/api/health", { signal: client.signal });

        await GET(request, context(["health"]));

        expect(reportError).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    // MIKE-FRONTEND-2C/-2V/-Y/-4E: the backend's body failed after the route
    // returned (undici's body timeout, a backend restart mid-stream), so the
    // handler's try/catch had exited and Next filed a context-free
    // "Failure in application".
    describe("an upstream body that fails mid-stream", () => {
        const socketClosed = () =>
            new TypeError("terminated", {
                cause: Object.assign(new Error("other side closed"), {
                    name: "SocketError",
                    code: "UND_ERR_SOCKET",
                }),
            });
        const failingBody = (error: unknown) => {
            let sent = false;
            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (!sent) {
                        sent = true;
                        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
                        return;
                    }
                    controller.error(error);
                },
            });
        };

        // An event stream errors too: the chat client resumes a turn only
        // when its read fails, so a clean end would leave the answer partial.
        it("reports one pinned warning and errors an event stream so the client resumes", async () => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const failure = socketClosed();
            fetchMock.mockResolvedValue(
                new Response(failingBody(failure), { headers: { "content-type": "text/event-stream" } }),
            );
            const request = new NextRequest("https://app.example.test/api/chat", { method: "POST", body: "{}" });

            const response = await POST(request, context(["chat"]));

            const reader = response.body!.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
            await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
            expect(reportError).toHaveBeenCalledTimes(1);
            expect(reportError).toHaveBeenCalledWith(failure, {
                level: "warning",
                fingerprint: ["upstream-unavailable"],
                tags: expect.objectContaining({
                    component: "api-gateway",
                    stage: "gateway-stream",
                    http_route: "/chat",
                    http_status: 200,
                    failure_code: "UND_ERR_SOCKET",
                }),
            });
            expect(warn).toHaveBeenCalledWith("[api-gateway] upstream response stream failed", failure, expect.any(Object));
        });

        it.each(["11111111-1111-4111-8111-111111111111", null, "private-customer-value"])(
            "correlates a body failure with the browser request ID (upstream: %s)",
            async (upstreamRequestId) => {
                const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
                const failure = new Error("response interrupted");
                fetchMock.mockResolvedValue(new Response(failingBody(failure), {
                    headers: upstreamRequestId ? { "x-request-id": upstreamRequestId } : {},
                }));

                const response = await GET(new NextRequest("https://app.example.test/api/documents"), context(["documents"]));
                const requestId = response.headers.get("x-request-id");
                expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
                if (upstreamRequestId?.startsWith("11111111")) expect(requestId).toBe(upstreamRequestId);
                await expect(readBody(response)).rejects.toMatchObject({ name: "AbortError" });
                expect(reportError).toHaveBeenCalledWith(failure, expect.objectContaining({
                    tags: expect.objectContaining({ request_id: requestId }),
                }));
                expect(warn).toHaveBeenCalledWith("[api-gateway] upstream response stream failed", failure, { requestId });
            },
        );

        // A body timeout means the backend is up but held the stream silent
        // for 300 s: a hang, not an outage. Like an unrecognised code it keeps
        // an error-level report with default grouping (MIKE-FRONTEND-2C).
        it("keeps distinct unknown failures and body timeouts eligible for final transport sampling", async () => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            const bodyTimeout = () =>
                new TypeError("terminated", {
                    cause: Object.assign(new Error("Body Timeout Error"), {
                        name: "BodyTimeoutError",
                        code: "UND_ERR_BODY_TIMEOUT",
                    }),
                });
            for (const failure of [bodyTimeout(), bodyTimeout(), new TypeError("terminated"), new Error("distinct defect")]) {
                fetchMock.mockResolvedValueOnce(
                    new Response(failingBody(failure), { headers: { "content-type": "text/event-stream" } }),
                );
                const response = await POST(
                    new NextRequest("https://app.example.test/api/chat", { method: "POST", body: "{}" }),
                    context(["chat"]),
                );
                await expect(readBody(response)).rejects.toMatchObject({ name: "AbortError" });
            }

            expect(reportError).toHaveBeenCalledTimes(4);
            for (const [, options] of vi.mocked(reportError).mock.calls) {
                expect(options).not.toHaveProperty("level");
                expect(options).not.toHaveProperty("fingerprint");
                expect(options).toMatchObject({ tags: { component: "api-gateway", stage: "gateway-stream" } });
            }
            expect(vi.mocked(reportError).mock.calls[0][1]).toMatchObject({
                tags: { failure_code: "UND_ERR_BODY_TIMEOUT" },
            });
        });

        it("aborts any other body so a truncated download never looks complete", async () => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            fetchMock.mockResolvedValue(
                new Response(failingBody(socketClosed()), { headers: { "content-type": "application/pdf" } }),
            );

            const response = await GET(
                new NextRequest("https://app.example.test/api/single-documents/doc/file"),
                context(["single-documents", "doc", "file"]),
            );

            await expect(readBody(response)).rejects.toMatchObject({ name: "AbortError" });
            expect(reportError).toHaveBeenCalledTimes(1);
        });
    });

    it("returns a sanitized 502 when the backend is unavailable", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED backend"));
        const request = new NextRequest("https://app.example.test/api/health");

        const response = await GET(request, context(["health"]));

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toEqual({
            detail: "The API is temporarily unavailable.",
                reporting_owner: "backend",
            request_id: response.headers.get("x-request-id"),
        });
    });

    // MIKE-FRONTEND-4/5/8: a self-hoster whose browser gets a 502 has to be
    // able to find WHY in their own Next server log (ECONNREFUSED, DNS,
    // TLS). Their local log is not the privacy boundary; the Sentry
    // transport is, and it drops this log line as already reported.
    it("logs the upstream error for the operator, and Sentry does not file the log twice", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const failure = new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3001"), {
                code: "ECONNREFUSED",
            }),
        });
        fetchMock.mockRejectedValue(failure);
        const request = new NextRequest("https://app.example.test/api/models/configured");

        const response = await GET(request, context(["models", "configured"]));
        const requestId = response.headers.get("x-request-id");

        expect(errorSpy).toHaveBeenCalledWith(
            "[api-gateway] upstream request failed",
            failure,
            { requestId, stage: "gateway-fetch" },
        );

        // The real scrubber: once reportError marked the error, the console
        // bridge's copy of this exact log call is dropped, not re-sent.
        const { createEventScrubber } = await vi.importActual<
            typeof import("@mike/client")
        >("@mike/client");
        const scrubber = createEventScrubber();
        const [reported] = reportError.mock.calls.at(-1) as [unknown];
        scrubber.markReported(reported);
        expect(
            scrubber.scrubEvent(
                { logger: "console", message: "[api-gateway] upstream request failed" },
                { captureContext: { extra: { arguments: errorSpy.mock.calls.at(-1) } } },
            ),
        ).toBeNull();
    });

    it("reads API_BASE_URL when the gateway handles the request", async () => {
        vi.stubEnv("API_BASE_URL", "https://backend.example.test/base");
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        const request = new NextRequest(
            "https://app.example.test/api/health?full=true",
        );

        const response = await GET(request, context(["health"]));

        const [upstreamUrl] = fetchMock.mock.calls[0] as [URL, RequestInit];
        expect(upstreamUrl.toString()).toBe(
            "https://backend.example.test/base/health?full=true",
        );
        expect(response.status).toBe(204);
    });

    it("fails safely when production runtime configuration is missing", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("API_BASE_URL", "");
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const request = new NextRequest("https://app.example.test/api/health");

        const response = await GET(request, context(["health"]));

        expect(fetchMock).not.toHaveBeenCalled();
        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toEqual({
            detail: "The API is temporarily unavailable.",
                reporting_owner: "backend",
            request_id: response.headers.get("x-request-id"),
        });
        expect(errorSpy).toHaveBeenCalledWith(
            "[api-gateway] upstream request failed",
            expect.any(Error),
            expect.objectContaining({
                stage: "gateway-config",
                requestId: response.headers.get("x-request-id"),
            }),
        );
    });

    // MIKE-FRONTEND-J/4: a stopped backend behind the gateway produced an
    // error-level issue per HTTP method (and per route), ten events in two
    // minutes, and the browser got a bare 502. It is one condition.
    describe("unreachable backend", () => {
        // Node's fetch: TypeError('fetch failed') whose cause is an
        // AggregateError of per-address connect errors (IPv6 + IPv4).
        const connectRefused = () => {
            const perAddress = (address: string) =>
                Object.assign(new Error(`connect ECONNREFUSED ${address}:3001`), {
                    code: "ECONNREFUSED",
                });
            const aggregate = Object.assign(
                new AggregateError([perAddress("::1"), perAddress("127.0.0.1")], ""),
                { code: "ECONNREFUSED" },
            );
            return new TypeError("fetch failed", { cause: aggregate });
        };

        it("answers 503 with a stable code and never the undici text", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            fetchMock.mockRejectedValue(connectRefused());
            const response = await POST(
                new NextRequest("https://app.example.test/api/chat", { method: "POST", body: "{}" }),
                context(["chat"]),
            );

            expect(response.status).toBe(503);
            expect(response.headers.get("retry-after")).toBe("5");
            const body = await response.json();
            expect(body).toEqual({
                detail: "The API is temporarily unavailable.",
                reporting_owner: "backend",
                code: "upstream_unavailable",
                request_id: response.headers.get("x-request-id"),
            });
            expect(JSON.stringify(body)).not.toMatch(/fetch failed|ECONNREFUSED|127\.0\.0\.1/);
        });

        it("reports one pinned warning per cause per minute, across methods and routes", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            fetchMock.mockImplementation(() => Promise.reject(connectRefused()));

            await POST(new NextRequest("https://app.example.test/api/chat", { method: "POST", body: "{}" }), context(["chat"]));
            await GET(new NextRequest("https://app.example.test/api/projects"), context(["projects"]));
            await GET(new NextRequest("https://app.example.test/api/models/configured"), context(["models", "configured"]));

            expect(reportError).toHaveBeenCalledTimes(1);
            expect(reportError.mock.calls[0]?.[1]).toMatchObject({
                level: "warning",
                fingerprint: ["upstream-unavailable"],
                tags: {
                    component: "api-gateway",
                    stage: "gateway-fetch",
                    http_status: 503,
                    failure_code: "ECONNREFUSED",
                },
            });

            // A different cause (a wrong API_BASE_URL host) is its own fact.
            fetchMock.mockRejectedValueOnce(
                new TypeError("fetch failed", {
                    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api"), { code: "ENOTFOUND" }),
                }),
            );
            await GET(new NextRequest("https://app.example.test/api/projects"), context(["projects"]));
            expect(reportError).toHaveBeenCalledTimes(2);
            expect(reportError.mock.calls[1]?.[1]).toMatchObject({ tags: { failure_code: "ENOTFOUND" } });
        });
    });
});


it('correlates gateway failures with the browser using a generated ID and a safe route', async () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('private upstream'), { code: 'ECONNREFUSED' }) });
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', fetch);
    upstreamReportWindow.reset();
    const request = new NextRequest('https://app.example.test/api/projects/private-name/documents?q=secret', {
        headers: { 'x-request-id': 'untrusted-private-value' },
    });
    try {
        const response = await GET(request, context(['projects', 'private-name', 'documents']));
        const requestId = response.headers.get('x-request-id');
        expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-request-id')).toBe(requestId);
        expect((await response.json()).request_id).toBe(requestId);
        expect(reportError).toHaveBeenLastCalledWith(error, {
            level: 'warning',
            fingerprint: ['upstream-unavailable'],
            tags: {
                component: 'api-gateway', stage: 'gateway-fetch', http_method: 'GET',
                http_route: '/projects/:id/documents', http_status: 503, request_id: requestId,
                failure_code: 'ECONNREFUSED',
            },
        });
        expect(JSON.stringify(reportError.mock.calls.at(-1)?.[1])).not.toMatch(/private|secret|untrusted/);
    } finally { vi.unstubAllGlobals(); }
});
