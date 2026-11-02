import { afterEach, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import { parseTextToolCalls } from "../llm/toolCallParsing";
import { resetSentryForTests, scrubEvent } from "./sentry";

afterEach(async () => {
  await Sentry.close();
});

it("drops logged model bodies and positional content from real console envelopes", async () => {
  const events: Sentry.Event[] = [];
  resetSentryForTests("community");
  Sentry.init({
    dsn: "https://test@sentry.invalid/1",
    defaultIntegrations: false,
    integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
    beforeSend: scrubEvent,
    // Real event preparation and console integration, with no network transport.
    transport: () => ({
      send: async (envelope) => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === "event") events.push(payload as Sentry.Event);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  const previous = process.env.DEBUG_LLM_TOOL_CALLS;
  process.env.DEBUG_LLM_TOOL_CALLS = "1";
  try {
    expect(() => parseTextToolCalls(
      '<tool_call>{"SYNTHETIC_PRIVATE_CLAUSE": 1:2}</tool_call>', 1,
    )).toThrow();
    console.error("[probe] failed", "SYNTHETIC_POSITIONAL_CONTENT");
    console.error("person@example.test", {
      error: new Error("Request to https://internal.firm.example/api/projects failed"),
    });
    expect(await Sentry.flush(2000)).toBe(true);
    expect(events).toHaveLength(3);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("SYNTHETIC_PRIVATE_CLAUSE");
    expect(serialized).not.toContain("SYNTHETIC_POSITIONAL_CONTENT");
    expect(serialized).not.toContain("person@example.test");
    expect(serialized).not.toContain("internal.firm.example");
    expect(events[0]?.message).toBe("[openai-compatible] unrecoverable textual tool call");
    expect(events[1]?.message).toBe("[probe] failed");
    expect(events[2]?.fingerprint).toEqual(["console", "[email]", "Error"]);
  } finally {
    if (previous === undefined) delete process.env.DEBUG_LLM_TOOL_CALLS;
    else process.env.DEBUG_LLM_TOOL_CALLS = previous;
  }
});
