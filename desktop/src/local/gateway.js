// Only the backend's Supabase clients use this gateway. The browser uses
// Mike's same-origin API and HttpOnly cookies, never direct Supabase access.
// Require per-install keys and reject browser requests so an unrelated
// website cannot exercise local auth endpoints (including signup).

const http = require("http");
const { PORTS } = require("./config");

function startGateway({ anonKey, serviceRoleKey, port = PORTS.gateway, upstreamPorts = PORTS }) {
  if (!anonKey || !serviceRoleKey) throw new Error("Local gateway requires per-install API keys");
  const routes = [
    { prefix: "/auth/v1/", port: upstreamPorts.gotrue },
    { prefix: "/rest/v1/", port: upstreamPorts.postgrest },
  ];

  const server = http.createServer((req, res) => {
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined || req.method === "OPTIONS") {
      res.writeHead(403, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: "local gateway requires server access" }));
    }
    if (req.headers.apikey !== anonKey && req.headers.apikey !== serviceRoleKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: "local gateway key required" }));
    }
    const route = routes.find((r) => req.url.startsWith(r.prefix));
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: "not found" }));
    }

    const headers = { ...req.headers };
    delete headers.host;

    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: route.port,
        path: req.url.slice(route.prefix.length - 1),
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        const outHeaders = { ...upstreamRes.headers };
        for (const key of Object.keys(outHeaders)) {
          if (key.startsWith("access-control-")) delete outHeaders[key];
        }
        res.writeHead(upstreamRes.statusCode, outHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "local stack upstream unavailable" }));
    });
    req.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { startGateway };
