// The local Supabase gateway — a Node port of supabase/gateway.conf.
//
// supabase-js in the browser talks to ONE base URL and expects /auth/v1/* and
// /rest/v1/* under it; this proxy strips those prefixes and forwards to
// GoTrue and PostgREST on their loopback ports, handling CORS exactly like
// the nginx config does (allow the calling origin, allow credentials,
// answer preflights directly).
//
// It does one job nginx didn't: apikey substitution. The frontend bundle
// bakes a PLACEHOLDER anon key (the well-known Supabase demo key — see
// config.js); the per-install real anon JWT exists only on this machine.
// Whenever a request carries the placeholder in `apikey` or as a Bearer
// token, the proxy swaps in the real anon key. Only ever anon-for-anon:
// nothing that passes through here can escalate to service_role, whose JWT
// never leaves the backend's environment.

const http = require("http");
const { PORTS, PLACEHOLDER_ANON_KEY } = require("./config");

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": req.headers.origin || "*",
    "Access-Control-Allow-Credentials": "true",
  };
}

function startGateway({ anonKey }) {
  const routes = [
    { prefix: "/auth/v1/", port: PORTS.gotrue },
    { prefix: "/rest/v1/", port: PORTS.postgrest },
  ];

  const server = http.createServer((req, res) => {
    const route = routes.find((r) => req.url.startsWith(r.prefix));
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: "not found" }));
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders(req),
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          req.headers["access-control-request-headers"] || "*",
        "Access-Control-Max-Age": "86400",
        "Content-Length": "0",
      });
      return void res.end();
    }

    const headers = { ...req.headers };
    delete headers.host;
    if (headers.apikey === PLACEHOLDER_ANON_KEY) headers.apikey = anonKey;
    if (headers.authorization === `Bearer ${PLACEHOLDER_ANON_KEY}`) {
      headers.authorization = `Bearer ${anonKey}`;
    }

    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: route.port,
        path: req.url.slice(route.prefix.length - 1),
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        const outHeaders = { ...upstreamRes.headers, ...corsHeaders(req) };
        // The proxy's CORS answer must win — mirror nginx's
        // proxy_hide_header by dropping any upstream CORS origin first.
        delete outHeaders["access-control-allow-origin"];
        Object.assign(outHeaders, corsHeaders(req));
        res.writeHead(upstreamRes.statusCode, outHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json", ...corsHeaders(req) });
      res.end(JSON.stringify({ error: "local stack upstream unavailable" }));
    });
    req.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORTS.gateway, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { startGateway };
