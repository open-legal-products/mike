// k6 load test for the SSE chat streaming path (POST /chat).
//
// This is the product's hot path and the source of past incidents (stream
// timeouts on long tool calls), so it gets a dedicated harness. It is
// ON-DEMAND tooling — run it by hand or via .github/workflows/loadtest.yml
// pointed at any non-production deployment of the backend API you own
// (it must serve POST /chat behind Supabase bearer auth, with real LLM
// provider keys configured). Never point it at production:
// every iteration creates a real chat row and burns real LLM tokens on the
// target stack.
//
// Endpoint shape (from backend/src/modules/chat/chat.routes.ts):
//   POST {BASE_URL}/chat
//   Authorization: Bearer <supabase access token>
//   Body: { "messages": [{ "role": "user", "content": "..." }] }
//   Response: text/event-stream. First event is
//   `data: {"type":"chat_id",...}`, then streamed events, terminated by
//   `data: [DONE]`.
//
// k6's plain http client buffers the response, which is exactly what we
// want for pass/fail measurement:
//   - http_req_waiting  = time-to-first-byte (headers flush + first event)
//   - http_req_duration = full stream lifetime (until [DONE] / socket close)
//
// Required env:
//   BASE_URL    e.g. http://localhost:3001 or the staging backend URL
//   AUTH_TOKEN  a valid Supabase access token for a test user
// Optional env:
//   VUS            peak concurrent streams (default 5)
//   RAMP_DURATION  ramp-up time (default 30s)
//   HOLD_DURATION  time at peak (default 2m)
//   PROMPT         the user message to send (default below)
//   STREAM_TIMEOUT per-request timeout (default 300s — long tool calls are
//                  the incident class we're probing, so don't cut this short)
//
// NOTE on rate limits: the backend ships with RATE_LIMIT_CHAT_MAX=30 per
// 15 min per IP (backend/src/app.ts). A load test from one IP will trip
// that almost immediately — raise it on the TARGET stack for the test run,
// e.g. RATE_LIMIT_CHAT_MAX=100000. 429s show up here as failed checks.

import http from "k6/http";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";
const VUS = parseInt(__ENV.VUS || "5", 10);
const PROMPT =
    __ENV.PROMPT ||
    "In two short sentences, what is the difference between an NDA and a confidentiality clause?";

// Custom metrics: separate "the stream completed cleanly" from generic
// HTTP success, and track full-stream duration on completed streams only.
const streamCompleted = new Rate("sse_stream_completed");
const streamErrorEvent = new Rate("sse_stream_error_event");
const streamDuration = new Trend("sse_stream_duration", true);
const ttfb = new Trend("sse_ttfb", true);

export const options = {
    scenarios: {
        sse_ramp: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
                // Ramp to N concurrent streams, hold, ramp down. Each VU
                // runs one full stream per iteration, so "VUs at peak" ==
                // "concurrent open SSE streams at peak".
                { duration: __ENV.RAMP_DURATION || "30s", target: VUS },
                { duration: __ENV.HOLD_DURATION || "2m", target: VUS },
                { duration: "15s", target: 0 },
            ],
            gracefulRampDown: "330s", // let in-flight streams finish
        },
    },
    // Deliberately LENIENT thresholds — this harness exists to produce
    // numbers and catch regressions of the "streams hang/time out" class,
    // not to enforce an SLO we haven't agreed on yet:
    //   - TTFB p95 < 15s: first byte is written right after auth + chat
    //     creation + doc-context DB work, before the LLM responds, so even
    //     a heavily loaded stack should manage 15s. Past-incident guard.
    //   - 90% of streams must complete (reach [DONE] or a clean error
    //     event): allows for a few upstream-LLM hiccups under load.
    //   - error-event rate < 20%: an in-stream `{"type":"error"}` event is
    //     a degraded-but-handled outcome; a spike means the stack is
    //     falling over.
    thresholds: {
        sse_ttfb: ["p(95)<15000"],
        sse_stream_completed: ["rate>0.90"],
        sse_stream_error_event: ["rate<0.20"],
        http_req_failed: ["rate<0.10"],
    },
};

export function setup() {
    if (!AUTH_TOKEN) {
        throw new Error(
            "AUTH_TOKEN is required (a Supabase access token for a test user). " +
                "See docs/test-depth.md for how to mint one against the local stack.",
        );
    }
    // Fail fast with a readable message if the target is unreachable or the
    // token is bad, instead of producing a wall of failed checks.
    const res = http.get(`${BASE_URL}/chat?limit=1`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    if (res.status !== 200) {
        throw new Error(
            `Preflight GET /chat returned ${res.status} — check BASE_URL and AUTH_TOKEN. Body: ${String(res.body).slice(0, 300)}`,
        );
    }
}

export default function () {
    const res = http.post(
        `${BASE_URL}/chat`,
        JSON.stringify({ messages: [{ role: "user", content: PROMPT }] }),
        {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${AUTH_TOKEN}`,
            },
            timeout: __ENV.STREAM_TIMEOUT || "300s",
            tags: { name: "POST /chat (SSE)" },
        },
    );

    const body = typeof res.body === "string" ? res.body : "";
    // The route writes the chat_id event immediately after flushing headers,
    // so its presence proves the stream actually started (vs. an error page
    // that happened to return 200).
    const started =
        res.status === 200 && body.includes('"type":"chat_id"');
    // `[DONE]` is the terminal sentinel on both the success and the handled-
    // error path — its absence means the stream was cut off mid-flight,
    // which is precisely the incident class this harness watches for.
    const completed = started && body.includes("data: [DONE]");

    check(res, {
        "status is 200": (r) => r.status === 200,
        "content-type is event-stream": (r) =>
            String(r.headers["Content-Type"] || "").includes(
                "text/event-stream",
            ),
        "stream started (chat_id event)": () => started,
        "stream completed ([DONE] received)": () => completed,
    });

    ttfb.add(res.timings.waiting);
    streamCompleted.add(completed);
    streamErrorEvent.add(body.includes('"type":"error"'));
    if (completed) streamDuration.add(res.timings.duration);
}
