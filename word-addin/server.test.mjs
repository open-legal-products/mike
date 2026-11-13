import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWordAddinServer } from "./server.mjs";

let backend;
let addin;
let backendOrigin;
let addinOrigin;
let staticRoot;
let observedRequest;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

before(async () => {
  staticRoot = await mkdtemp(path.join(os.tmpdir(), "mike-word-host-"));
  await writeFile(
    path.join(staticRoot, "taskpane.html"),
    "<!doctype html><title>Mike Word</title>",
  );
  await writeFile(path.join(staticRoot, "taskpane.js"), "void 0;");

  backend = http.createServer((req, res) => {
    observedRequest = {
      url: req.url,
      cookie: req.headers.cookie,
      origin: req.headers.origin,
      forwardedHost: req.headers["x-forwarded-host"],
    };
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "set-cookie": [
        "__Host-mike-session=one; Path=/; Secure; HttpOnly",
        "__Host-mike-session.1=two; Path=/; Secure; HttpOnly",
      ],
    });
    res.write("data: first\n\n");
    setImmediate(() => res.end("data: second\n\n"));
  });
  backendOrigin = await listen(backend);
  addin = createWordAddinServer({
    distRoot: staticRoot,
    backendOrigin,
  });
  addinOrigin = await listen(addin);
});

after(async () => {
  await Promise.all([close(addin), close(backend)]);
  await rm(staticRoot, { recursive: true, force: true });
});

test("serves health and the task pane", async () => {
  const health = await fetch(`${addinOrigin}/health`);
  assert.deepEqual(await health.json(), { ok: true });

  const taskpane = await fetch(`${addinOrigin}/`);
  assert.equal(taskpane.status, 200);
  assert.match(await taskpane.text(), /Mike Word/);
});

test("asks crawlers not to index the add-in pages", async () => {
  for (const pathname of ["/", "/taskpane.html"]) {
    const page = await fetch(`${addinOrigin}${pathname}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  }
  const asset = await fetch(`${addinOrigin}/taskpane.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("x-robots-tag"), null);
});

test("streams the API while preserving auth headers and cookies", async () => {
  const response = await fetch(`${addinOrigin}/api/chat?mode=word`, {
    headers: {
      cookie: "__Host-mike-session=incoming",
      origin: "https://word.example.test",
    },
  });

  assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
  assert.deepEqual(observedRequest, {
    url: "/chat?mode=word",
    cookie: "__Host-mike-session=incoming",
    origin: "https://word.example.test",
    forwardedHost: new URL(addinOrigin).host,
  });
  assert.deepEqual(response.headers.getSetCookie(), [
    "__Host-mike-session=one; Path=/; Secure; HttpOnly",
    "__Host-mike-session.1=two; Path=/; Secure; HttpOnly",
  ]);
});

test("rejects backend configuration that is not an origin", () => {
  for (const backendOrigin of [
    "https://backend.example.test/path",
    "https://backend.example.test?target=other",
    "https://user:password@backend.example.test",
  ]) {
    assert.throws(
      () => createWordAddinServer({ distRoot: staticRoot, backendOrigin }),
      /must be an http\(s\) origin/,
    );
  }
});
