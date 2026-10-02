import { afterEach, describe, expect, it, vi } from "vitest";

const reportError = vi.hoisted(() => vi.fn(() => "event-1"));
vi.mock("./observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./observability/sentry")>()),
  reportError,
}));

import express from "express";
import request from "supertest";
import { SCHEMA_OUT_OF_DATE_MESSAGE, sendInternalError } from "./httpError";

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
      code: "22P02",
      message: 'invalid input syntax for type uuid: "private-value"',
      details: null,
      hint: null,
    };

    const res = await request(appThatFails(pg)).get("/projects/p-1");

    expect(res.status).toBe(500);
    const reported = (reportError.mock.calls[0] as unknown[])[0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.cause).toBe(pg);
    expect(reported.message).toBe("Dependency failure (22P02)");
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

  // MIKE-BACKEND-H: GET /chat on an install whose migrations were never
  // applied (the list RPC does not exist, PGRST202) answered an opaque 500
  // internal_error, and the operator log said nothing about migrations.
  it.each(["PGRST202", "PGRST204", "PGRST205", "42P01"])(
    "answers a schema-behind-code failure (%s) with an intentional 503, one report, and an operator hint",
    async (code) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pg = {
        code,
        message: "Could not find the function public.private_rpc(p_user_id) in the schema cache",
        details: "private detail",
        hint: "Perhaps you meant public.private_other",
      };

      const res = await request(appThatFails(pg)).get("/projects/p-1");

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        code: "schema_out_of_date",
        detail: SCHEMA_OUT_OF_DATE_MESSAGE,
        request_id: "req-abc",
      });
      expect(JSON.stringify(res.body)).not.toMatch(/private|schema cache/);
      // One event, carrying the code in the cause chain for failure_code.
      expect(reportError).toHaveBeenCalledOnce();
      const [reported, context] = reportError.mock.calls[0] as unknown as [
        Error,
        { tags: Record<string, unknown> },
      ];
      expect(reported.cause).toBe(pg);
      expect(context.tags.http_status).toBe(503);
      // Operator-facing, and not on console.error (the Sentry bridge would
      // file a string there as a second event).
      expect(consoleWarn).toHaveBeenCalledOnce();
      expect(String(consoleWarn.mock.calls[0]?.[0])).toContain("backend/migrations");
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("private");
      expect(consoleError).toHaveBeenCalledOnce();
    },
  );

  it("finds the schema code on a wrapped Error's cause and leaves look-alike code bugs as 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapped = new Error("list failed", { cause: { code: "PGRST202" } });
    expect((await request(appThatFails(wrapped)).get("/projects/p-1")).status).toBe(503);

    for (const code of ["42883", "42703", "23505"]) {
      const res = await request(appThatFails({ code })).get("/projects/p-1");
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("internal_error");
    }
  });
});
