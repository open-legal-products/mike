import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as Sentry from "@sentry/node";
import { reportError, reportProcessWarning, resetSentryForTests, scrubEvent } from "./sentry";
import { privacyBoundaryIntegration } from "./sentryPrivacy";
import { extractionFailureFromWire, extractionFailureToWire } from "../extraction/failure";
import { decryptString } from "../mcp/client";

afterEach(async () => { await Sentry.close(); resetSentryForTests(); vi.unstubAllEnvs(); });
it("preserves parser locations, missing-secret diagnosis and finite listener context in final envelopes", async () => {
  const sent: Sentry.Event[] = [];
  resetSentryForTests("official", { initialized: true });
  Sentry.init({
    dsn: "https://test@sentry.invalid/1", defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ["error"] })],
    beforeSend: scrubEvent,
    transport: () => ({ send: async envelope => {
      for (const [header, payload] of envelope[1]) if (header.type === "event") sent.push(payload as Sentry.Event);
      return { statusCode: 200 };
    }, flush: async () => true }),
  });
  const parser = new TypeError("PRIVATE_DOCUMENT");
  parser.stack = "TypeError: PRIVATE_DOCUMENT\n    at parse (backend/src/lib/extract.ts:42:7)";
  reportError(extractionFailureFromWire(structuredClone(extractionFailureToWire(parser))), { tags: { operation: "documents.extract", job_kind: "document_extract" } });
  vi.stubEnv("MCP_CONNECTORS_ENCRYPTION_SECRET", "");
  vi.stubEnv("USER_API_KEYS_ENCRYPTION_SECRET", "");
  expect(decryptString("PRIVATE_CREDENTIAL", "iv", "tag")).toBeNull();
  reportProcessWarning(Object.assign(new Error("PRIVATE_WARNING"), { name: "MaxListenersExceededWarning", emitter: new EventEmitter(), type: "abort", count: 11 }));
  await Sentry.flush(2000);
  expect(sent).toHaveLength(3);
  expect(sent[0]?.exception?.values?.some(v => v.stacktrace?.frames?.some(f => f.filename === "backend/src/lib/extract.ts" && f.lineno === 42))).toBe(true);
  expect(sent[1]?.tags).toMatchObject({ error_kind: "configuration.encryption_secret_missing", failure_code: "configuration_invalid", configuration_fields: "MCP_CONNECTORS_ENCRYPTION_SECRET,USER_API_KEYS_ENCRYPTION_SECRET" });
  expect(sent[2]?.tags).toMatchObject({ warning_emitter: "EventEmitter", warning_event: "abort", warning_listener_count: 11 });
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_");
});
