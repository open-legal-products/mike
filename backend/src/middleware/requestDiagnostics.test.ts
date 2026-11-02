import { afterEach, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import * as Sentry from "@sentry/node";
import { AppError } from "../lib/appError";
import { resetSentryForTests, scrubEvent, setOperation } from "../lib/observability/sentry";
import { privacyBoundaryIntegration } from "../lib/observability/sentryPrivacy";
import { requestDiagnostics } from "./requestDiagnostics";

type Frame = { filename?: string; lineno?: number; colno?: number };
type WireEvent = Sentry.Event & { stacktrace?: { frames?: Frame[] } };
const PRIVATE_FILE = "Jane_Doe_NDA.pdf";
const PRIVATE_EMAIL = "jane@example.test";
function sourcePosition(error: Error) {
  const match = error.stack?.match(/requestDiagnostics\.test\.ts:(\d+):(\d+)/);
  if (!match) throw new Error("Expected a test source location");
  return { lineno: Number(match[1]), colno: Number(match[2]) };
}
function frames(event: WireEvent): Frame[] {
  return [...(event.stacktrace?.frames ?? []),
    ...(event.exception?.values?.flatMap(value => value.stacktrace?.frames ?? []) ?? [])];
}

afterEach(async () => {
  await Sentry.close();
  resetSentryForTests("community");
  vi.restoreAllMocks();
});

it.each(["community", "official"] as const)("gives console captures private-free request context and exact locations in %s mode", async install => {
  const events: WireEvent[] = [];
  resetSentryForTests(install, { initialized: true });
  Sentry.init({
    dsn: "https://test@sentry.invalid/1", defaultIntegrations: false,
    attachStacktrace: true,
    integrations: [privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ["error"] })],
    beforeSend: scrubEvent,
    transport: () => ({
      send: async envelope => {
        for (const [header, payload] of envelope[1]) if (header.type === "event") events.push(payload as WireEvent);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  const app = express();
  app.use(requestDiagnostics);
  app.use(express.json());
  let releaseDocuments!: () => void;
  const workflowStarted = new Promise<void>(resolve => { releaseDocuments = resolve; });
  let nestedPosition: ReturnType<typeof sourcePosition>;
  let plainPosition: ReturnType<typeof sourcePosition>;
  app.post("/documents/:documentId", async (_req, res) => {
    // A different request changes operation while this request is suspended.
    await workflowStarted;
    const failure = new AppError("db.query_failed", PRIVATE_FILE, { cause: { code: "42501", message: PRIVATE_EMAIL } });
    nestedPosition = sourcePosition(failure);
    console.error("private label " + PRIVATE_FILE, { error: failure, email: PRIVATE_EMAIL });
    const marker = new Error();
    console.error(PRIVATE_FILE, { code: "ECONNRESET", message: PRIVATE_EMAIL });
    plainPosition = { ...sourcePosition(marker), lineno: sourcePosition(marker).lineno + 1 };
    res.sendStatus(204);
  });
  app.get("/workflows/:workflowId", async (_req, res) => {
    setOperation("workflows.run");
    releaseDocuments();
    await new Promise<void>(resolve => setImmediate(resolve));
    console.error("private workflow " + PRIVATE_FILE, new Error(PRIVATE_EMAIL));
    res.sendStatus(204);
  });
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    console.error("body parsing failed", { error });
    res.sendStatus(400);
  };
  app.use(handleError);
  const [documents, workflow] = await Promise.all([
    request(app).post(`/documents/${PRIVATE_FILE}?email=${PRIVATE_EMAIL}`).set("Authorization", "Bearer PRIVATE_TOKEN").send({ content: PRIVATE_FILE }),
    request(app).get(`/workflows/${PRIVATE_FILE}?email=${PRIVATE_EMAIL}`),
  ]);
  // Fails before a route is selected, so a req.route-based solution cannot help.
  const malformed = await request(app).post(`/documents/${PRIVATE_FILE}`).set("Content-Type", "application/json").send(`{"private":"${PRIVATE_EMAIL}"`);
  await Sentry.flush(2000);
  expect(documents.status).toBe(204);
  expect(workflow.status).toBe(204);
  expect(malformed.status).toBe(400);
  expect(events).toHaveLength(4);
  const documentEvents = events.filter(event => event.tags?.request_id === documents.headers["x-request-id"]);
  expect(documentEvents).toHaveLength(2);
  for (const event of documentEvents) expect(event.tags).toMatchObject({
    operation: "http.request", component: "http", http_method: "POST", http_route: "/documents/:id", capture_source: "console",
  });
  const nested = documentEvents.find(event => event.tags?.failure_code === "42501")!;
  expect(nested.tags?.error_kind).toBe("db.query_failed");
  expect(frames(nested)).toContainEqual(expect.objectContaining({ filename: expect.stringContaining("requestDiagnostics.test.ts"), ...nestedPosition! }));
  const plain = documentEvents.find(event => event.tags?.failure_code === "ECONNRESET")!;
  expect(frames(plain)).toContainEqual(expect.objectContaining({ filename: expect.stringContaining("requestDiagnostics.test.ts"), lineno: plainPosition!.lineno, colno: expect.any(Number) }));
  expect(events.find(event => event.tags?.request_id === workflow.headers["x-request-id"])?.tags).toMatchObject({
    operation: "workflows.run", component: "http", http_method: "GET", http_route: "/workflows/:id",
  });
  expect(events.find(event => event.tags?.request_id === malformed.headers["x-request-id"])?.tags).toMatchObject({
    operation: "http.request", component: "http", http_method: "POST", http_route: "/documents/:id",
  });
  const wire = JSON.stringify(events);
  for (const privateValue of [PRIVATE_FILE, PRIVATE_EMAIL, "PRIVATE_TOKEN"]) expect(wire).not.toContain(privateValue);
  expect(wire).not.toContain("Failure in application");
  expect(Sentry.getIsolationScope().getScopeData().tags.request_id).toBeUndefined();
});
