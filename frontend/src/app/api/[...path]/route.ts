import { randomUUID } from "node:crypto";
import { reportError } from "@/app/lib/errorReporting";
import { diagnosticRoute } from "@/shared/lib/sentryPrivacy";
import type { NextRequest } from "next/server";
import {
    UPSTREAM_UNAVAILABLE_FINGERPRINT,
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

    const requestId = randomUUID();
    let stage = "gateway-config";
    try {
        const upstreamUrl = new URL(`${backendOrigin()}${requestPath}`);
        upstreamUrl.search = request.nextUrl.search;

        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("connection");
        headers.delete("content-length");
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
        };
        if (request.method !== "GET" && request.method !== "HEAD") {
            init.body = request.body;
            init.duplex = "half";
        }

        stage = "gateway-fetch";
        const upstream = await fetch(upstreamUrl, init);
        stage = "gateway-response";
        const responseHeaders = new Headers(upstream.headers);
        // Fetch implementations may transparently decompress the response.
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");

        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        });
    } catch (error) {
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

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
