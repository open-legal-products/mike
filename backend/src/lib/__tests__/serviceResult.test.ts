import { describe, expect, it, vi } from "vitest";
import {
  failure,
  internalFailure,
  isFailure,
  ok,
  sendServiceFailure,
} from "../serviceResult";

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    locals: {} as Record<string, unknown>,
    req: { method: "GET", originalUrl: "/x" },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

describe("serviceResult", () => {
  it("maps each failure kind to its status code", () => {
    const cases = [
      ["validation", 400],
      ["forbidden", 403],
      ["not_found", 404],
      ["conflict", 409],
      ["unavailable", 503],
    ] as const;
    for (const [kind, status] of cases) {
      const res = fakeRes();
      sendServiceFailure(res as never, failure(kind, "why"));
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ detail: "why" });
    }
  });

  it("surfaces an optional machine-readable code", () => {
    const res = fakeRes();
    sendServiceFailure(res as never, failure("conflict", "busy", "in_progress"));
    expect(res.body).toEqual({ detail: "busy", code: "in_progress" });
  });

  it("routes internal errors through sendInternalError without leaking them", () => {
    const res = fakeRes();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendServiceFailure(res as never, internalFailure(new Error("secret")));
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret");
    spy.mockRestore();
  });

  it("narrows with isFailure", () => {
    const success = ok({ id: 1 });
    expect(isFailure(success)).toBe(false);
    if (!isFailure(success)) expect(success.data.id).toBe(1);
    expect(isFailure(failure("not_found", "x"))).toBe(true);
  });
});
