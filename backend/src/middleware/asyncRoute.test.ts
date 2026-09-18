import { afterEach, describe, expect, it, vi } from "vitest";

const reportError = vi.hoisted(() => vi.fn(() => "event-1"));
vi.mock("../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/observability/sentry")>()),
  reportError,
}));

import express from "express";
import request from "supertest";
import { asyncRoute, routerErrorHandler } from "./asyncRoute";

describe("routerErrorHandler", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("reports the error to Sentry BEFORE logging it, so the console bridge sees a known error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const failure = new Error("relation private_table does not exist");
    const app = express();
    const router = express.Router();
    router.get(
      "/boom",
      asyncRoute(async () => {
        throw failure;
      }),
    );
    router.use(routerErrorHandler("[test-router]"));
    app.use("/api", router);

    const res = await request(app).get("/api/boom");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal_error");
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure, expect.anything());
    // Order is the whole point: report, then the router's own log line.
    const [reportOrder] = reportError.mock.invocationCallOrder;
    const routerLogOrder = consoleError.mock.calls.findIndex(
      ([first]) => first === "[test-router] unhandled route error",
    );
    expect(routerLogOrder).toBeGreaterThanOrEqual(0);
    expect(reportOrder).toBeLessThan(
      consoleError.mock.invocationCallOrder[routerLogOrder]!,
    );
  });

  it("hands a failure after headers were sent to the next handler without reporting twice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = express();
    const router = express.Router();
    router.get(
      "/stream",
      asyncRoute(async (_req, res) => {
        res.write("partial");
        throw new Error("mid-stream");
      }),
    );
    router.use(routerErrorHandler("[test-router]"));
    app.use("/api", router);

    await request(app).get("/api/stream").catch(() => undefined);
    expect(reportError).not.toHaveBeenCalled();
  });
});
