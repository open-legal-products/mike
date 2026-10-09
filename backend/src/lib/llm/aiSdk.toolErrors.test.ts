/**
 * Stub-LanguageModel tests for the tool-fault seam in streamAiSdk: which
 * errors end the turn, with which identity, and what happens to the SDK's
 * step loop afterwards. No network, no keys.
 */
import { describe, expect, it, vi } from "vitest";

import { stopNotice, streamAiSdk } from "./aiSdk";
import { UserFacingError } from "../userFacingError";
import type { NormalizedToolCall } from "./types";
import {
  AssistantStreamAskInputsPause,
  callStep,
  config,
  finish,
  makeModel,
  okRunTools,
  readsAsCancel,
  step,
  text,
  textStep,
  tick,
  toolCall,
  TOOLS,
} from "./__tests__/mockLanguageModel";

const base = {
  model: "m",
  systemPrompt: "S",
  messages: [{ role: "user" as const, content: "go" }],
  tools: TOOLS,
  maxIterations: 5,
};

describe("success path is untouched", () => {
  it("tool step then text step: one runTools batch per step, text returned", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("done"),
    ]);
    const batches: NormalizedToolCall[][] = [];
    const res = await streamAiSdk(
      {
        ...base,
        runTools: async (calls) => {
          batches.push(calls);
          return okRunTools(calls);
        },
      },
      config(model),
    );
    expect(res.fullText).toBe("done");
    expect(batches).toEqual([
      [{ id: "c1", name: "read_document", input: { doc_id: "doc-0" } }],
    ]);
    expect(model.doStreamCalls.length).toBe(2);
  });

  it("the iteration cap retains the upstream stop notice and ends the loop", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      callStep("c2", "read_document", { doc_id: "doc-1" }),
      textStep("never"),
    ]);
    const res = await streamAiSdk(
      { ...base, runTools: okRunTools, maxIterations: 2 },
      config(model),
    );
    expect(res.fullText).toBe(stopNotice(2, 2, "tool-calls"));
    await tick();
    expect(model.doStreamCalls.length).toBe(2);
  });

  it("retains the upstream default of 16 rounds and streams its stop notice", async () => {
    const model = await makeModel([
      ...Array.from({ length: 16 }, (_, i) =>
        callStep(`c${i}`, "read_document", { doc_id: `doc-${i}` }),
      ),
      textStep("must not run past the default cap"),
    ]);
    const deltas: string[] = [];
    const result = await streamAiSdk(
      {
        ...base,
        maxIterations: undefined,
        runTools: okRunTools,
        callbacks: {
          onContentDelta: (delta) => {
            deltas.push(delta);
          },
        },
      },
      config(model),
    );
    expect(model.doStreamCalls).toHaveLength(16);
    expect(result.fullText).toBe(stopNotice(16, 16, "tool-calls"));
    expect(deltas.join("")).toBe(result.fullText);
  });

  it("forwards upstream conversation cache hints through a recovered call", async () => {
    const model = await makeModel([
      callStep("bad", "read_document", '{"doc_id":'),
      textStep("recovered"),
    ]);
    const result = await streamAiSdk(
      { ...base, conversationId: "chat-1", runTools: okRunTools },
      config(model),
    );
    expect(result.fullText).toBe("recovered");
    expect(model.doStreamCalls).toHaveLength(2);
    for (const call of model.doStreamCalls) {
      expect(call.providerOptions).toMatchObject({
        openai: { promptCacheKey: "chat-1" },
      });
      expect(call.prompt).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" } },
            },
          }),
        ]),
      );
    }
  });
});

describe("upstream provider guidance stays separate from tool failures", () => {
  const cases = [
    [401, "", "was rejected"],
    [402, "", "out of credits"],
    [403, "", "isn't available"],
    [404, "", "isn't available"],
    [429, "", "rate limit or quota reached"],
    [429, "limit: 0", "plan doesn't include"],
  ] as const;

  for (const source of ["stream part", "before stream"] as const) {
    it.each(cases)(
      `${source}: provider %i keeps actionable guidance (%s)`,
      async (statusCode, responseBody, message) => {
        const error = Object.assign(new Error("provider request failed"), {
          statusCode,
          responseBody,
        });
        const model = await makeModel(
          source === "stream part" ? [step({ type: "error", error })] : [error],
        );
        let caught: unknown;
        try {
          await streamAiSdk({ ...base, runTools: okRunTools }, config(model));
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(UserFacingError);
        expect((caught as Error).message).toContain(message);
      },
    );
  }

  it("a provider RetryError retains quota guidance", async () => {
    const lastError = Object.assign(new Error("quota exhausted"), {
      statusCode: 429,
    });
    const error = Object.assign(new Error("Failed after 3 attempts"), {
      lastError,
    });
    const model = await makeModel([error]);
    await expect(streamAiSdk({ ...base }, config(model))).rejects.toMatchObject(
      {
        message: expect.stringContaining("rate limit or quota reached"),
      },
    );
  });

  it.each(cases)(
    "tool %i keeps the original failure and stops (%s)",
    async (statusCode, responseBody) => {
      const failure = Object.assign(new Error("tool service unavailable"), {
        statusCode,
        responseBody,
      });
      const model = await makeModel([
        callStep("c1", "read_document", { doc_id: "doc-0" }),
        textStep("must not retry a genuine tool failure"),
      ]);
      await expect(
        streamAiSdk(
          {
            ...base,
            runTools: async () => {
              throw failure;
            },
          },
          config(model),
        ),
      ).rejects.toBe(failure);
      expect(failure).not.toBeInstanceOf(UserFacingError);
      await tick();
      expect(model.doStreamCalls).toHaveLength(1);
    },
  );
});

describe("a genuine execute() failure ends the turn with its ORIGINAL instance", () => {
  class UserFacingLike extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UserFacingLike";
    }
  }

  it("custom Error subclasses thrown by runTools keep class, name and message", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    const thrown = new UserFacingLike("Document too large to read.");
    let caught: unknown;
    try {
      await streamAiSdk(
        {
          ...base,
          runTools: async () => {
            throw thrown;
          },
        },
        config(model),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(thrown);
    expect(caught).toBeInstanceOf(UserFacingLike);
    await tick();
    await tick();
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("the ask_inputs pause propagates by instance and stops the step loop", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    const pause = new AssistantStreamAskInputsPause();
    let caught: unknown;
    try {
      await streamAiSdk(
        {
          ...base,
          runTools: async () => {
            throw pause;
          },
        },
        config(model),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(pause);
    await tick();
    await tick();
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("a non-Error rejection is wrapped in an Error carrying its text", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    let caught: unknown;
    try {
      await streamAiSdk(
        {
          ...base,
          runTools: async () => {
            throw "plain string failure";
          },
        },
        config(model),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("plain string failure");
  });

  it("a missing tool result names the call and prevents the next model step", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    await expect(
      streamAiSdk({ ...base, runTools: async () => [] }, config(model)),
    ).rejects.toThrow(/returned no result for call c1/);
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("a partially returned parallel batch stops before another model request", async () => {
    const model = await makeModel([
      step(
        toolCall("c1", "read_document", { doc_id: "doc-0" }),
        toolCall("c2", "read_document", { doc_id: "doc-1" }),
        finish("tool-calls"),
      ),
      textStep("must not run after a missing parallel result"),
    ]);
    const batches: NormalizedToolCall[][] = [];
    await expect(
      streamAiSdk(
        {
          ...base,
          runTools: async (calls) => {
            batches.push(calls);
            return okRunTools(calls.filter((call) => call.id === "c1"));
          },
        },
        config(model),
      ),
    ).rejects.toThrow(/returned no result for call c2/);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((call) => call.id)).toEqual(["c1", "c2"]);
    await tick();
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe("abort-shaped exceptions are not user cancels", () => {
  it("a tool throwing DOMException('x','AbortError') with NO signal aborted takes the error path; message + original preserved", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    const bogus = new DOMException("x", "AbortError");
    let caught: unknown;
    try {
      await streamAiSdk(
        {
          ...base,
          runTools: async () => {
            throw bogus;
          },
        },
        config(model),
      );
    } catch (e) {
      caught = e;
    }
    expect(readsAsCancel(caught)).toBe(false);
    const err = caught as Error & { cause?: unknown };
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("Error");
    expect(err.message).toBe("x");
    expect(err.cause).toBe(bogus);
    await tick();
    await tick();
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("a provider `error` part named AbortError with no abort pending takes the error path too", async () => {
    const providerErr = Object.assign(new Error("connection reset"), {
      name: "AbortError",
    });
    const model = await makeModel([
      step(...text("partial"), { type: "error", error: providerErr }),
    ]);
    let caught: unknown;
    try {
      await streamAiSdk({ ...base, runTools: okRunTools }, config(model));
    } catch (e) {
      caught = e;
    }
    expect(readsAsCancel(caught)).toBe(false);
    expect((caught as Error).message).toBe("connection reset");
    expect((caught as { cause?: unknown }).cause).toBe(providerErr);
  });

  it("an error carrying isAbortError's exact MESSAGE is de-fanged without losing the text", async () => {
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    let caught: unknown;
    try {
      await streamAiSdk(
        {
          ...base,
          runTools: async () => {
            throw new Error("Stream aborted.");
          },
        },
        config(model),
      );
    } catch (e) {
      caught = e;
    }
    expect(readsAsCancel(caught)).toBe(false);
    expect((caught as Error).message).toContain("Stream aborted.");
  });

  it("a genuine abort (caller's signal aborted inside a tool) keeps the cancel path, original instance intact", async () => {
    const abort = new AbortController();
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    const real = new DOMException("The operation was aborted.", "AbortError");
    let caught: unknown;
    try {
      await streamAiSdk(
        {
          ...base,
          abortSignal: abort.signal,
          runTools: async () => {
            abort.abort();
            throw real;
          },
        },
        config(model),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(real);
    expect(readsAsCancel(caught)).toBe(true);
  });

  it("an executor failure remains visible when the caller aborts at the same time", async () => {
    const abort = new AbortController();
    const failure = new Error("document storage unavailable");
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    await expect(
      streamAiSdk(
        {
          ...base,
          abortSignal: abort.signal,
          runTools: async () => {
            abort.abort();
            throw failure;
          },
        },
        config(model),
      ),
    ).rejects.toBe(failure);
    await tick();
    await tick();
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("a caller abort during a model step is forwarded to the SDK and still reads as a cancel", async () => {
    const abort = new AbortController();
    const model = await makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    let caught: unknown;
    try {
      await streamAiSdk(
        {
          ...base,
          abortSignal: abort.signal,
          runTools: async (calls) => {
            abort.abort();
            return okRunTools(calls);
          },
        },
        config(model),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(readsAsCancel(caught)).toBe(true);
    await tick();
    await tick();
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("an already-aborted caller signal takes the cancel path without another model step", async () => {
    const abort = new AbortController();
    abort.abort();
    const model = await makeModel([textStep("must never be requested")]);
    let caught: unknown;
    try {
      await streamAiSdk(
        { ...base, abortSignal: abort.signal, runTools: okRunTools },
        config(model),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(readsAsCancel(caught)).toBe(true);
    // The mock model ignores the signal, so the SDK may still record one
    // doStream call before it observes the abort.
    expect(model.doStreamCalls.length).toBeLessThanOrEqual(1);
  });
});

describe("provider stall (chunk timeouts)", () => {
  it("a model that goes silent mid-stream ends the turn with an error that does not read as a user cancel", async () => {
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
    vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t0" });
            controller.enqueue({ type: "text-delta", id: "t0", delta: "hi" });
            // ...and then nothing, until the SDK gives up.
            abortSignal?.addEventListener("abort", () =>
              controller.error(abortSignal.reason),
            );
          },
        }),
      }),
    });
    const outcome = await streamAiSdk(
      { ...base, runTools: okRunTools },
      config(model as never),
    ).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    vi.unstubAllEnvs();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.e).toBeInstanceOf(UserFacingError);
    expect((outcome.e as Error).message).toMatch(/stopped responding/);
    expect(readsAsCancel(outcome.e)).toBe(false);
  }, 30_000);

  it("a user Stop during a silent stream is still a cancel, not a stall", async () => {
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            abortSignal?.addEventListener("abort", () =>
              controller.error(abortSignal.reason),
            );
          },
        }),
      }),
    });
    const user = new AbortController();
    const pending = streamAiSdk(
      { ...base, runTools: okRunTools, abortSignal: user.signal },
      config(model as never),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    user.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(UserFacingError);
    expect(readsAsCancel(error)).toBe(true);
  }, 30_000);
});
