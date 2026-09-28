// MIKE-BACKEND-A: "Failure in http / GET / /:id / 500" whose only stack was
// rooted inside the Sentry reporter. A supabase-js query returns its error
// as a PLAIN object ({ code, message, details, hint }); a service hands that
// to internalFailure(), and nothing on the way to Sentry had a stack for it,
// so the reporter's fallback `new Error(...)` became the "culprit" and the
// SQLSTATE/PostgREST code that would have named the fault was lost.
//
// These tests drive the real routers and assert what reaches reportError.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportError, rpc, from } = vi.hoisted(() => ({
  reportError: vi.fn((_error: unknown, _context?: unknown) => "event-1"),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/observability/sentry")>()),
  reportError,
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({ from, rpc }),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "7a0c3a52-7f1e-4a57-9b3c-1b0c6c3f9e11";
    next();
  },
}));

import { quickActionsRouter } from "../../modules/quick-actions/quickActions.routes";
import { workflowAddonsRouter } from "../../modules/workflows/workflowAddons.routes";
import { diagnosticErrorTags } from "../../lib/observability/sentryPrivacy";

// What PostgREST answers for a table that the database does not have (a
// self-hosted install whose schema is behind the code).
const missingTable = {
  code: "PGRST205",
  message:
    "Could not find the table 'public.quick_actions' in the schema cache",
  details: null,
  hint: "Perhaps you meant the table 'public.private_things'",
};

function failingQuery(error: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "in"]) {
    query[method] = vi.fn(() => query);
  }
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data: null, error }).then(resolve, reject);
  return query;
}

const app = express();
app.use((_req, res, next) => {
  res.locals.requestId = "7db9e42e-81ba-4b63-be51-4b6bb00e1866";
  next();
});
app.use("/quick-actions", quickActionsRouter);
app.use("/workflow-addons", workflowAddonsRouter);

function reported(): Error {
  expect(reportError).toHaveBeenCalledOnce();
  return reportError.mock.calls[0]![0] as Error;
}

describe("a PostgREST error returned by a list service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: 0, error: null });
  });

  it.each([
    ["/quick-actions", "quickActions.service"],
    ["/workflow-addons", "workflows.addons"],
  ])(
    "GET %s reports an Error captured in the service, carrying the code",
    async (path, serviceFile) => {
      from.mockImplementation(() => failingQuery(missingTable));

      const res = await request(app).get(path);

      // Client contract unchanged: generic body, request id, nothing raw.
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        code: "internal_error",
        detail: "Something went wrong. Please try again.",
        request_id: "7db9e42e-81ba-4b63-be51-4b6bb00e1866",
      });
      expect(JSON.stringify(res.body)).not.toContain("quick_actions");

      const error = reported();
      expect(error).toBeInstanceOf(Error);
      // The original object stays reachable, unmodified, as the cause...
      expect(error.cause).toBe(missingTable);
      // ...its code becomes the allowlisted failure_code tag...
      expect(diagnosticErrorTags(error)).toMatchObject({
        failure_code: "PGRST205",
      });
      // ...its free text never enters the reported message...
      expect(error.message).not.toContain("quick_actions");
      expect(error.message).not.toContain("private_things");
      // ...and the TOP frame is the service that ran the query, not the
      // reporter or the HTTP helper.
      const firstFrame = error.stack!.split("\n")[1] ?? "";
      expect(firstFrame).toContain(serviceFile);
      expect(error.stack).not.toContain("observability/sentry");
    },
  );
});
