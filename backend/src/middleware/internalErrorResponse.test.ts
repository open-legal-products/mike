import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const reportMessage = vi.hoisted(() => vi.fn(() => "event-1"));
vi.mock("../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/observability/sentry")>()),
  reportMessage,
}));
import {
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
} from "../lib/httpError";
import {
  handleUnhandledError,
  protectInternalErrorResponses,
} from "./internalErrorResponse";

function testApp(status: number, body: unknown) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.requestId = "req-test-123";
    next();
  });
  app.use(protectInternalErrorResponses);
  app.get("/test", (_req, res) => res.status(status).json(body));
  return app;
}

describe("protectInternalErrorResponses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("reports a hand-written 5xx under its mounted route pattern, so two routers with the same relative path stay separate issues", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    app.use(protectInternalErrorResponses);
    const projects = express.Router();
    projects.get("/:id", (_req, res) =>
      res.status(500).json({ detail: "projects broke" }),
    );
    const documents = express.Router();
    documents.get("/:id", (_req, res) =>
      res.status(500).json({ detail: "documents broke" }),
    );
    app.use("/projects", projects);
    app.use("/documents", documents);

    await request(app).get("/projects/p-1");
    await request(app).get("/documents/d-1");

    expect(reportMessage).toHaveBeenCalledTimes(2);
    const [first, second] = reportMessage.mock.calls as unknown as [
      [string, { tags: { http_route: string }; fingerprint: string[] }],
      [string, { tags: { http_route: string }; fingerprint: string[] }],
    ];
    expect(first[1].tags.http_route).toBe("/projects/:id");
    expect(second[1].tags.http_route).toBe("/documents/:id");
    expect(first[1].fingerprint).toEqual(["sanitized-5xx", "GET", "/projects/:id"]);
    expect(second[1].fingerprint).toEqual(["sanitized-5xx", "GET", "/documents/:id"]);
  });

  it.each([500, 502, 503])(
    "replaces raw %i responses with the public contract",
    async (status) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const res = await request(testApp(status, {
        detail: "relation private_table does not exist",
        stack: "secret stack",
      })).get("/test");

      expect(res.status).toBe(status);
      expect(res.body).toEqual({
        code: INTERNAL_ERROR_CODE,
        detail: INTERNAL_ERROR_MESSAGE,
        request_id: "req-test-123",
      });
      expect(res.text).not.toContain("private_table");
      expect(res.text).not.toContain("secret stack");
      expect(consoleError).toHaveBeenCalledOnce();
    },
  );

  it("does not rewrite intentional client errors", async () => {
    const body = { code: "invalid_filename", detail: "Filename is required" };
    const res = await request(testApp(400, body)).get("/test");
    expect(res.status).toBe(400);
    expect(res.body).toEqual(body);
  });

  it("strips extra fields from an otherwise sanitized 5xx response", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await request(
      testApp(500, {
        code: INTERNAL_ERROR_CODE,
        detail: INTERNAL_ERROR_MESSAGE,
        request_id: "untrusted-request-id",
        stack: "secret stack",
      }),
    ).get("/test");

    expect(res.body).toEqual({
      code: INTERNAL_ERROR_CODE,
      detail: INTERNAL_ERROR_MESSAGE,
      request_id: "req-test-123",
    });
    expect(res.text).not.toContain("secret stack");
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("sanitizes an unhandled route exception", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const app = express();
    app.use((_req, res, next) => {
      res.locals.requestId = "req-thrown-123";
      next();
    });
    app.use(protectInternalErrorResponses);
    app.get("/test", () => {
      throw new Error("database password appeared in a stack");
    });
    app.use(handleUnhandledError);

    const res = await request(app).get("/test");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: INTERNAL_ERROR_CODE,
      detail: INTERNAL_ERROR_MESSAGE,
      request_id: "req-thrown-123",
    });
    expect(res.text).not.toContain("database password");
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("returns a safe 400 response for malformed JSON", async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.requestId = "req-json-123";
      next();
    });
    app.use(protectInternalErrorResponses);
    app.use(express.json());
    app.post("/test", (_req, res) => res.sendStatus(204));
    app.use(handleUnhandledError);

    const res = await request(app)
      .post("/test")
      .set("Content-Type", "application/json")
      .send('{"secret":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "invalid_json",
      detail: "Request body must contain valid JSON.",
      request_id: "req-json-123",
    });
    expect(res.text).not.toContain("secret");
  });

  it("returns a safe 413 response for oversized JSON", async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.requestId = "req-size-123";
      next();
    });
    app.use(protectInternalErrorResponses);
    app.use(express.json({ limit: "10b" }));
    app.post("/test", (_req, res) => res.sendStatus(204));
    app.use(handleUnhandledError);

    const res = await request(app)
      .post("/test")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ secret: "a very long internal payload" }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      code: "request_too_large",
      detail: "The request body is too large.",
      request_id: "req-size-123",
    });
    expect(res.text).not.toContain("secret");
  });
});
