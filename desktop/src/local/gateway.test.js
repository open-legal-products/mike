const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startGateway } = require("./gateway");

async function fixture(t) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gateway = await startGateway({ anonKey: "install-anon", serviceRoleKey: "install-service", port: 0,
    upstreamPorts: { gotrue: upstreamPort, postgrest: upstreamPort } });
  t.after(() => Promise.all([upstream, gateway].map((server) => new Promise((resolve) => server.close(resolve)))));
  return { received, url: `http://127.0.0.1:${gateway.address().port}` };
}

test("backend Supabase clients preserve anon, service-role, and session authorization", async (t) => {
  const f = await fixture(t);
  for (const [prefix, key] of [["/auth/v1/token?grant_type=password", "install-anon"], ["/rest/v1/user_profiles", "install-service"]]) {
    const response = await fetch(f.url + prefix, { headers: { apikey: key, authorization: "Bearer session-jwt" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    await response.text();
  }
  assert.equal(f.received[0].url, "/token?grant_type=password");
  assert.equal(f.received[1].url, "/user_profiles");
  assert.equal(f.received[0].headers.apikey, "install-anon");
  assert.equal(f.received[0].headers.authorization, "Bearer session-jwt");
  assert.equal(f.received[1].headers.apikey, "install-service");
});

test("unrelated websites cannot reach local signup or database endpoints", async (t) => {
  const f = await fixture(t);
  for (const headers of [{ origin: "https://unrelated.example" }, { origin: "null" }, { "sec-fetch-site": "same-origin" }]) {
    const response = await fetch(f.url + "/auth/v1/signup", { method: "POST", headers: { apikey: "install-anon", ...headers } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    await response.text();
  }
  assert.equal(f.received.length, 0);
});

test("public placeholders and missing keys are never promoted into installation credentials", async (t) => {
  const f = await fixture(t);
  for (const headers of [{}, { apikey: "public-demo-key", authorization: "Bearer public-demo-key" }]) {
    const response = await fetch(f.url + "/auth/v1/signup", { method: "POST", headers });
    assert.equal(response.status, 401);
    await response.text();
  }
  const preflight = await fetch(f.url + "/auth/v1/signup", { method: "OPTIONS" });
  assert.equal(preflight.status, 403);
  await preflight.text();
  assert.equal(f.received.length, 0);
});
