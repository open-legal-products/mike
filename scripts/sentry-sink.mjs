#!/usr/bin/env node
// A local stand-in for Sentry's ingest endpoint, for verifying error tracking
// without an account: point any Mike runtime's DSN at it and every event the
// SDK would have sent to sentry.io lands here instead, printed to the
// terminal and listed at http://localhost:<port>/ .
//
//   node scripts/sentry-sink.mjs            # listens on 9999
//   SENTRY_DSN=http://mike@localhost:9999/1  (backend)
//   NEXT_PUBLIC_SENTRY_DSN=http://mike@localhost:9999/2  (web app, browser)
//   REACT_APP_SENTRY_DSN=http://mike@localhost:9999/3    (Word add-in)
//
// The project number in the DSN is arbitrary; it only shows up in the path
// the SDK posts to (/api/<project>/envelope/). No dependencies: Node 22 only.

import http from "node:http";
import { createGunzip, createInflate } from "node:zlib";

const port = Number.parseInt(process.env.PORT ?? "9999", 10);
const events = [];
const MAX_EVENTS = 500;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 5 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3100",
  "http://127.0.0.1:3100",
  "https://localhost:3200",
  "https://127.0.0.1:3200",
]);

class PayloadTooLargeError extends Error {}

/** Collect a bounded request body while continuing to drain oversized uploads. */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      req.resume();
      reject(new PayloadTooLargeError("compressed request body is too large"));
      return;
    }

    const chunks = [];
    let received = 0;
    let oversized = false;
    req.on("data", (chunk) => {
      if (oversized) return;
      received += chunk.length;
      if (received > MAX_REQUEST_BYTES) {
        oversized = true;
        chunks.length = 0;
        reject(new PayloadTooLargeError("compressed request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
    req.once("aborted", () => reject(new Error("request aborted")));
  });
}

/** Decompress without blocking the event loop or retaining oversized output. */
function decompress(raw, encoding) {
  return new Promise((resolve, reject) => {
    const decoder = encoding === "gzip" ? createGunzip() : createInflate();
    const chunks = [];
    let decoded = 0;
    let settled = false;

    decoder.on("data", (chunk) => {
      if (settled) return;
      decoded += chunk.length;
      if (decoded > MAX_DECOMPRESSED_BYTES) {
        settled = true;
        decoder.destroy();
        reject(new PayloadTooLargeError("decompressed request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    decoder.once("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    decoder.once("error", (error) => {
      if (!settled) reject(error);
    });
    decoder.end(raw);
  });
}

/** Decode an uncompressed, gzip, or deflate request after enforcing both limits. */
async function decodeBody(req) {
  const raw = await readRequestBody(req);
  const encoding = req.headers["content-encoding"];
  if (encoding === "gzip" || encoding === "deflate") {
    return (await decompress(raw, encoding)).toString("utf8");
  }
  return raw.toString("utf8");
}

/** Permit browser access only from the sink itself and Mike's local app origins. */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type, x-sentry-auth, sentry-trace, baggage",
    "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
    vary: "Origin",
  };
}

/** Sentry envelopes are newline-delimited JSON: header, then (item header, item payload) pairs. */
function parseEnvelope(text) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { _raw: line.slice(0, 200) };
    }
  });
  const [header, ...rest] = parsed;
  const items = [];
  for (let i = 0; i + 1 < rest.length; i += 2) {
    items.push({ header: rest[i], payload: rest[i + 1] });
  }
  return { header: header ?? {}, items };
}

function summarize(project, event) {
  const exception = event.exception?.values?.[0];
  const title = exception
    ? `${exception.type}: ${exception.value}`
    : event.message ?? "(no message)";
  const frame = exception?.stacktrace?.frames?.at(-1);
  return {
    received_at: new Date().toISOString(),
    project,
    level: event.level ?? "error",
    environment: event.environment ?? null,
    release: event.release ?? null,
    platform: event.platform ?? null,
    title,
    where: frame ? `${frame.filename ?? frame.abs_path}:${frame.lineno}` : null,
    tags: event.tags ?? {},
    user: event.user ?? null,
    request: event.request
      ? { method: event.request.method, url: event.request.url }
      : null,
    fingerprint: event.fingerprint ?? null,
    mechanism: exception?.mechanism?.type ?? null,
    event_id: event.event_id,
    raw: event,
  };
}

function record(project, event) {
  const summary = summarize(project, event);
  events.unshift(summary);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  const tags = Object.entries(summary.tags)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(
    `[${summary.received_at}] project=${project} level=${summary.level} ` +
      `${summary.title}${summary.where ? ` @ ${summary.where}` : ""}` +
      `${tags ? `\n    ${tags}` : ""}` +
      `${summary.request ? `\n    ${summary.request.method} ${summary.request.url}` : ""}` +
      `${summary.user ? `\n    user=${JSON.stringify(summary.user)}` : ""}`,
  );
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Sentry sink</title>
<style>
  body{font:14px/1.4 system-ui,sans-serif;margin:2rem;color:#111;background:#fafafa}
  h1{font-size:1.1rem;font-weight:600}
  .event{border:1px solid #ddd;border-radius:8px;padding:.75rem 1rem;margin:.5rem 0;background:#fff}
  .error{border-left:4px solid #d33}.warning{border-left:4px solid #e9a400}.fatal{border-left:4px solid #700}.info{border-left:4px solid #48c}
  .title{font-weight:600}.meta{color:#666;font-size:12px}.tags{font-family:ui-monospace,monospace;font-size:12px;margin-top:.25rem}
  .tag{display:inline-block;background:#eef;border-radius:4px;padding:0 .35rem;margin:.1rem .2rem 0 0}
  details{margin-top:.35rem}pre{font-size:11px;overflow:auto;max-height:20rem;background:#f4f4f4;padding:.5rem}
</style>
<h1>Sentry sink — <span id="count">0</span> events (newest first, refreshes every 2s)</h1>
<div id="list"></div>
<script>
async function refresh(){
  const events = await (await fetch('/events')).json();
  document.getElementById('count').textContent = events.length;
  document.getElementById('list').innerHTML = events.map(e => {
    const tags = Object.entries(e.tags).map(([k,v]) => '<span class="tag">'+esc(k)+'='+esc(v)+'</span>').join('');
    return '<div class="event '+esc(e.level)+'"><div class="title">'+esc(e.title)+'</div>'+
      '<div class="meta">'+esc(e.received_at)+' · project '+esc(e.project)+' · '+esc(e.level)+' · '+esc(e.platform||'')+' · '+esc(e.environment||'')+(e.where?' · '+esc(e.where):'')+(e.request?' · '+esc(e.request.method)+' '+esc(e.request.url):'')+(e.user?' · user '+esc(JSON.stringify(e.user)):'')+'</div>'+
      '<div class="tags">'+tags+'</div>'+
      '<details><summary>raw event</summary><pre>'+esc(JSON.stringify(e.raw,null,2))+'</pre></details></div>';
  }).join('');
}
function esc(s){return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
refresh(); setInterval(refresh, 2000);
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://sink.local");
  const origin = req.headers.origin;
  if (typeof origin === "string" && !ALLOWED_ORIGINS.has(origin)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Origin not allowed");
    return;
  }
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify(events));
    return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/events") {
    events.length = 0;
    res.writeHead(204, cors).end();
    return;
  }
  const ingest = url.pathname.match(/^\/api\/(\d+)\/(envelope|store)\/?$/);
  if (req.method === "POST" && ingest) {
    void (async () => {
      const project = ingest[1];
      try {
        const text = await decodeBody(req);
        if (ingest[2] === "store") {
          record(project, JSON.parse(text));
        } else {
          for (const item of parseEnvelope(text).items) {
            if (item.header?.type === "event") record(project, item.payload);
          }
        }
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          res.writeHead(413, { ...cors, "content-type": "application/json" });
          res.end('{"error":"payload too large"}');
          return;
        }
        console.error("[sink] could not parse envelope", error);
      }
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end("{}");
    })();
    return;
  }
  res.writeHead(404, cors).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Sentry sink listening on http://localhost:${port}`);
  console.log(`  DSN for any Mike runtime: http://mike@localhost:${port}/1`);
  console.log(`  Events page:               http://localhost:${port}/`);
});
