import { BACKEND_REPORTING_OWNER } from "@mike/client";
import { randomUUID } from "node:crypto";
import { reportError } from "@/app/lib/errorReporting";
import { diagnosticErrorTags, diagnosticRoute } from "@mike/client";
import type { NextRequest } from "next/server";
import {
    UPSTREAM_UNAVAILABLE_FINGERPRINT,
    forwardableHeaders,
    guardUpstreamBody,
    upstreamReportWindow,
    upstreamUnreachableCode,
} from "./upstreamFailure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function backendOrigin() {
    const configuredUrl = process.env.API_BASE_URL?.trim();
    if (!configuredUrl && process.env.NODE_ENV === "production") {
        throw new Error("API_BASE_URL is required at runtime.");
    }

    const backendUrl = new URL(configuredUrl || "http://localhost:3001");
    if (!["http:", "https:"].includes(backendUrl.protocol)) {
        throw new Error("API_BASE_URL must use http or https.");
    }
    return backendUrl.toString().replace(/\/$/, "");
}

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const requestPath = `/${path.map(encodeURIComponent).join("/")}`;

    let requestId: string = randomUUID();
    let stage = "gateway-config";
    try {
        const upstreamUrl = new URL(`${backendOrigin()}${requestPath}`);
        upstreamUrl.search = request.nextUrl.search;

        const headers = forwardableHeaders(request.headers);
        // Mint correlation here rather than trusting a caller-supplied ID.
        // The backend logs the same ID even if its response never arrives.
        headers.set("x-request-id", requestId);
        headers.set("x-forwarded-host", request.nextUrl.host);
        headers.set(
            "x-forwarded-proto",
            request.nextUrl.protocol.replace(":", ""),
        );

        const init: RequestInit & { duplex?: "half" } = {
            method: request.method,
            headers,
            cache: "no-store",
            redirect: "manual",
            // A client that goes away aborts the backend request too, instead
            // of leaving it to run until undici's body timeout.
            signal: request.signal,
        };
        if (request.method !== "GET" && request.method !== "HEAD") {
            init.body = request.body;
            init.duplex = "half";
        }

        stage = "gateway-fetch";
        const upstream = await fetch(upstreamUrl, init);
        stage = "gateway-response";
        const responseHeaders = forwardableHeaders(upstream.headers);
        // Correlate post-header failures with the backend and the ID the
        // browser receives. Only UUIDs survive the diagnostic privacy boundary.
        const upstreamRequestId = responseHeaders.get("x-request-id");
        if (upstreamRequestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(upstreamRequestId)) {
            requestId = upstreamRequestId;
        }
        responseHeaders.set("x-request-id", requestId);
        // Fetch implementations may transparently decompress the response.
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");

        const body = upstream.body
            ? guardUpstreamBody(upstream.body, (error) =>
                  reportStreamFailure(error, request, requestPath, requestId, upstream.status),
              )
            : null;
        return new Response(body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        });
    } catch (error) {
        // The client went away before the backend answered; the forwarded
        // signal aborted the backend request. Nobody is waiting for a
        // response and nothing failed.
        if (request.signal.aborted && stage === "gateway-fetch") {
            return new Response(null, { status: 499, headers: { "x-request-id": requestId } });
        }
        // A connection-level failure (ECONNREFUSED, DNS, reset, connect
        // timeout) means the backend is down or misaddressed: an operator
        // condition, not an application bug, and every request fails the
        // same way while it lasts (MIKE-FRONTEND-J/4: ten events in two
        // minutes, one issue per HTTP method). It is reported as ONE pinned
        // issue per cause, at warning level, at most once a minute.
        const unreachable =
            stage === "gateway-fetch" ? upstreamUnreachableCode(error) : null;
        const status = unreachable ? 503 : 502;
        const tags = {
            component: "api-gateway", stage,
            http_method: request.method,
            http_route: diagnosticRoute(requestPath),
            http_status: status,
            request_id: requestId,
        };
        if (!unreachable) {
            // Anything else (bad configuration, TLS, an unexpected throw)
            // is a fault worth an error-level issue of its own.
            reportError(error, { tags });
        } else if (upstreamReportWindow.allow(unreachable)) {
            reportError(error, {
                level: "warning",
                fingerprint: [UPSTREAM_UNAVAILABLE_FINGERPRINT],
                tags: { ...tags, failure_code: unreachable },
            });
        }
        // The operator's own server log keeps the real cause (ECONNREFUSED,
        // DNS, TLS): without it a self-hoster seeing 502s cannot tell a
        // stopped backend from a wrong API_BASE_URL. Privacy is enforced at
        // the Sentry transport, not here. The Error is the top-level
        // argument so a console bridge recognises the object reportError
        // marked and drops its copy as a duplicate.
        console.error("[api-gateway] upstream request failed", error, { requestId, stage });
        return Response.json(
            {
                detail: "The API is temporarily unavailable.",
                reporting_owner: BACKEND_REPORTING_OWNER,
                ...(unreachable ? { code: "upstream_unavailable" } : {}),
                request_id: requestId,
            },
            {
                status,
                headers: {
                    "x-request-id": requestId,
                    ...(unreachable ? { "retry-after": "5" } : {}),
                },
            },
        );
    }
}

/**
 * The backend's response failed after its headers were forwarded. Split the
 * same way as a failed fetch. A connection-level code (the backend went away
 * mid-stream: UND_ERR_SOCKET, ECONNRESET) is the same fact as an unreachable
 * backend, so it is one pinned warning per cause per minute; every open
 * stream fails the same way at the same moment. The stage tag keeps it a
 * separate issue from a refused connection (see diagnosticEvent).
 * Anything else, including undici's 300 s body timeout (the backend is up but
 * held the stream silent: a hang, not an outage) and a code we do not know,
 * keeps an error-level report with default grouping; the final transport
 * owns repeat sampling. A client that disconnected first is not a failure.
 */
function reportStreamFailure(
    error: unknown,
    request: NextRequest,
    requestPath: string,
    requestId: string,
    status: number,
): void {
    if (request.signal.aborted) return;
    const code = diagnosticErrorTags(error).failure_code;
    const failureCode = typeof code === "string" ? code : undefined;
    const unreachable = upstreamUnreachableCode(error);
    if (!unreachable || upstreamReportWindow.allow(`gateway-stream:${unreachable}`)) {
        const tags = {
            component: "api-gateway",
            stage: "gateway-stream",
            http_method: request.method,
            http_route: diagnosticRoute(requestPath),
            http_status: status,
            request_id: requestId,
            failure_code: failureCode,
        };
        if (unreachable) {
            reportError(error, {
                level: "warning",
                fingerprint: [UPSTREAM_UNAVAILABLE_FINGERPRINT],
                tags,
            });
        } else {
            reportError(error, { tags });
        }
    }
    // console.warn: the operator's log keeps the cause; the Sentry console
    // bridge only forwards console.error.
    console.warn("[api-gateway] upstream response stream failed", error, { requestId });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
