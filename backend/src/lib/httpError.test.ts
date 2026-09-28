import { afterEach, describe, expect, it, vi } from "vitest";

const reportError = vi.hoisted(() => vi.fn(() => "event-1"));
vi.mock("./observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./observability/sentry")>()),
  reportError,
}));

import express from "express";
import request from "supertest";
import { sendInternalError } from "./httpError";

function appThatFails(error: unknown, status?: number) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.requestId = "req-abc";
    next();
  });
  // Mounted the way app.ts mounts every feature router: the route pattern
  // Sentry sees must include the mount point, or /projects/:projectId and
  // /documents/:id would both report as "/:id".
  const projects = express.Router();
  projects.get("/:projectId", (_req, res) => {
    sendInternalError(res, error, status);
  });
  app.use("/projects", projects);
  return app;
}

describe("sendInternalError", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("reports the error to Sentry with the request id and route pattern, then answers 500", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const failure = new Error("relation private_table does not exist");

    const res = await request(appThatFails(failure)).get("/projects/p-123?code=private-oauth-code&state=private-oauth-state");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: "internal_error",
      detail: "Something went wrong. Please try again.",
      request_id: "req-abc",
    });
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure, {
      tags: {
        component: "http",
        http_status: 500,
        request_id: "req-abc",
        http_method: "GET",
        // Grouping key: the MOUNTED Express route pattern, not the concrete
        // URL and not the router-relative "/:projectId".
        http_route: "/projects/:projectId",
      },
      extra: { path: "/projects/p-123" },
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private-oauth");
    expect(JSON.stringify(reportError.mock.calls)).not.toContain("private-oauth");
    // Report first, log second: the console bridge must see a known error.
    expect(reportError.mock.invocationCallOrder[0]).toBeLessThan(
      consoleError.mock.invocationCallOrder[0],
    );
  });

  it("wraps a raw PostgREST object: stack from the caller, code kept, text dropped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pg = {
      code: "42P01",
      message: 'relation "public.private_table" does not exist',
      details: null,
      hint: null,
    };

    const res = await request(appThatFails(pg)).get("/projects/p-1");

    expect(res.status).toBe(500);
    const reported = (reportError.mock.calls[0] as unknown[])[0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.cause).toBe(pg);
    expect(reported.message).toBe("Dependency failure (42P01)");
    // The helper frames are dropped: the top frame is the route handler.
    expect(reported.stack!.split("\n")[1]).toContain("httpError.test");
  });

  it("passes a non-default status through to the report", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(appThatFails(new Error("upstream"), 503)).get(
      "/projects/p-1",
    );

    expect(res.status).toBe(503);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ http_status: 503 }),
      }),
    );
  });
});
