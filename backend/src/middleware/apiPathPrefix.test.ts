import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { stripApiPathPrefix } from "./apiPathPrefix";

function run(prefix: string | undefined, url: string): string {
  const req = { url } as Request;
  let called = false;
  stripApiPathPrefix(prefix)(req, {} as Response, () => {
    called = true;
  });
  expect(called).toBe(true);
  return req.url;
}

describe("stripApiPathPrefix", () => {
  it("removes the configured prefix and keeps the query", () => {
    expect(run("/api", "/api/chat/123")).toBe("/chat/123");
    expect(run("/api/", "/api/health?x=1")).toBe("/health?x=1");
    expect(run("/api", "/api?x=1")).toBe("/?x=1");
    expect(run("/api", "/api")).toBe("/");
  });

  it("leaves other paths alone", () => {
    expect(run("/api", "/apix/chat")).toBe("/apix/chat");
    expect(run("/api", "/chat")).toBe("/chat");
  });

  it("does nothing when no prefix is configured", () => {
    expect(run(undefined, "/api/chat")).toBe("/api/chat");
    expect(run("", "/api/chat")).toBe("/api/chat");
    expect(run("api", "/api/chat")).toBe("/api/chat");
  });
});
