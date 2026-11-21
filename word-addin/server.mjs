import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultDistRoot = fileURLToPath(new URL("./dist/", import.meta.url));

function configuredBackend(input) {
  if (!input?.trim()) {
    throw new Error("WORD_ADDIN_BACKEND_ORIGIN is required");
  }
  const backend = new URL(input);
  if (
    !["http:", "https:"].includes(backend.protocol) ||
    backend.username ||
    backend.password ||
    backend.pathname !== "/" ||
    backend.search ||
    backend.hash
  ) {
    throw new Error(
      "WORD_ADDIN_BACKEND_ORIGIN must be an http(s) origin without credentials, path, query, or fragment",
    );
  }
  return Object.freeze({
    protocol: backend.protocol,
    hostname: backend.hostname,
    port: backend.port || undefined,
    host: backend.host,
  });
}

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function publicProtocol(req) {
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded)
    return forwarded.split(",")[0].trim();
  return req.socket.encrypted ? "https" : "http";
}

function proxyApi(req, res, backend) {
  const incoming = new URL(req.url ?? "/", "http://word-addin.invalid");
  if (
    incoming.pathname !== "/api" &&
    !incoming.pathname.startsWith("/api/")
  ) {
    res.writeHead(400).end();
    return;
  }
  const upstreamPath = incoming.pathname.slice("/api".length) || "/";

  const headers = { ...req.headers };
  for (const name of HOP_BY_HOP) delete headers[name];
  headers.host = backend.host;
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = publicProtocol(req);

  const transport = backend.protocol === "https:" ? https : http;
  const upstream = transport.request(
    {
      protocol: backend.protocol,
      hostname: backend.hostname,
      port: backend.port,
      path: `${upstreamPath}${incoming.search}`,
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      for (const name of HOP_BY_HOP) delete responseHeaders[name];
      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    console.error("[word-addin/proxy] upstream request failed", {
      path: upstreamPath,
      error: error instanceof Error ? error.message : String(error),
    });
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ detail: "The API is temporarily unavailable." }));
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

async function serveStatic(req, res, distRoot) {
  const requestUrl = new URL(req.url ?? "/", "http://word-addin.invalid");
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === "/") pathname = "/taskpane.html";

  const relative = path.posix.normalize(pathname).replace(/^\/+/, "");
  const filename = path.resolve(distRoot, relative);
  if (filename !== distRoot && !filename.startsWith(`${distRoot}${path.sep}`)) {
    res.writeHead(404).end();
    return;
  }

  try {
    const info = await stat(filename);
    if (!info.isFile()) throw new Error("not a file");
    const isHtml = relative.endsWith(".html");
    res.writeHead(200, {
      "cache-control": isHtml
        ? "no-cache"
        : "public, max-age=31536000, immutable",
      "content-length": info.size,
      "content-type":
        MIME_TYPES.get(path.extname(filename).toLowerCase()) ??
        "application/octet-stream",
      "x-content-type-options": "nosniff",
      // The pages only work inside Word, so a search result or a link
      // preview of them leads nowhere (Sentry MIKE-WORD-ADDIN-6/7 were mostly
      // crawlers). Office ignores this header; it still needs the 200.
      ...(isHtml ? { "x-robots-tag": "noindex, nofollow" } : {}),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filename).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

export function createWordAddinServer(options = {}) {
  const distRoot = path.resolve(options.distRoot ?? defaultDistRoot);
  const backend = configuredBackend(
    options.backendOrigin ?? process.env.WORD_ADDIN_BACKEND_ORIGIN,
  );
  return http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api" || req.url?.startsWith("/api/")) {
      proxyApi(req, res, backend);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    void serveStatic(req, res, distRoot);
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? "3200", 10);
  const server = createWordAddinServer();
  server.listen(port, () => {
    console.log(`Mike Word add-in host running on port ${port}`);
  });
}
