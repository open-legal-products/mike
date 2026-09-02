import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import { openAssistantSse } from "../routeStreaming";

// A minimal ServerResponse double: records writes, tracks end state the way
// Node does (writableEnded flips on end()), and lets a test fire the 'close'
// event by hand.
function makeRes() {
  const closeHandlers: (() => void)[] = [];
  const res = {
    writableEnded: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "close") closeHandlers.push(handler);
    }),
  };
  return {
    res: res as unknown as Response,
    raw: res,
    emitClose: () => closeHandlers.forEach((handler) => handler()),
  };
}

describe("openAssistantSse", () => {
  it("passes writes through while the stream is open", () => {
    const { res, raw } = makeRes();
    const stream = openAssistantSse(res);

    expect(stream.write("data: hello\n\n")).toBe(true);
    expect(raw.write).toHaveBeenCalledWith("data: hello\n\n");
  });

  it("drops writes after finish() instead of writing into an ended response", () => {
    // The late writer this protects is real: the chat-title promise settles on
    // its own schedule, and the abort signal never fires when the route itself
    // finished the stream — so without this guard a resolved title lands as a
    // write-after-end, which Node reports as an async 'error' event no
    // caller's catch can reach.
    const { res, raw } = makeRes();
    const stream = openAssistantSse(res);

    stream.finish();

    expect(stream.write("data: too late\n\n")).toBe(false);
    expect(raw.write).not.toHaveBeenCalled();
  });

  it("drops writes once the response has ended underneath the helper", () => {
    const { res, raw } = makeRes();
    const stream = openAssistantSse(res);

    raw.writableEnded = true;

    expect(stream.write("data: too late\n\n")).toBe(false);
    expect(raw.write).not.toHaveBeenCalled();
  });

  it("aborts only when the client closes before finish()", () => {
    const early = makeRes();
    const earlyStream = openAssistantSse(early.res);
    early.emitClose();
    expect(earlyStream.signal.aborted).toBe(true);

    // After a normal finish, a close is just the connection winding down —
    // this is exactly why the abort signal cannot double as a late-write
    // guard.
    const late = makeRes();
    const lateStream = openAssistantSse(late.res);
    lateStream.finish();
    late.emitClose();
    expect(lateStream.signal.aborted).toBe(false);
  });
});
