/**
 * Stub-LanguageModel tests for the tool-fault seam in streamAiSdk: which
 * errors end the turn, with which identity, and what happens to the SDK's
 * step loop afterwards. No network, no keys.
 */
import { describe, expect, it } from "vitest";

import { streamAiSdk } from "./aiSdk";
import type { NormalizedToolCall } from "./types";
import {
  AssistantStreamAskInputsPause,
  callStep,
  config,
  makeModel,
  okRunTools,
  readsAsCancel,
  step,
  text,
  textStep,
  tick,
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
    const model = makeModel([
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

  it("the iteration cap still ends the loop quietly", async () => {
    const model = makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      callStep("c2", "read_document", { doc_id: "doc-1" }),
      textStep("never"),
    ]);
    const res = await streamAiSdk(
      { ...base, runTools: okRunTools, maxIterations: 2 },
      config(model),
    );
    expect(res.fullText).toBe("");
    await tick();
    expect(model.doStreamCalls.length).toBe(2);
  });
});

describe("a genuine execute() failure ends the turn with its ORIGINAL instance", () => {
  class UserFacingLike extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UserFacingLike";
    }
  }

  it("custom Error subclasses thrown by runTools keep class, name and message", async () => {
    const model = makeModel([
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
    const model = makeModel([
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
    const model = makeModel([
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

  it("a missing tool result is still reported as an Error naming the call", async () => {
    const model = makeModel([
      callStep("c1", "read_document", { doc_id: "doc-0" }),
      textStep("must never be requested"),
    ]);
    await expect(
      streamAiSdk({ ...base, runTools: async () => [] }, config(model)),
    ).rejects.toThrow(/returned no result for call c1/);
  });
});

describe("abort-shaped exceptions are not user cancels", () => {
  it("a tool throwing DOMException('x','AbortError') with NO signal aborted takes the error path; message + original preserved", async () => {
    const model = makeModel([
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
    const model = makeModel([
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
    const model = makeModel([
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
    const model = makeModel([
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
    const model = makeModel([
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
    const model = makeModel([
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
    const model = makeModel([textStep("must never be requested")]);
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
