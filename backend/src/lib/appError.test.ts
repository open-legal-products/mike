import { describe, expect, it } from "vitest";
import { AppError, withKind } from "./appError";
import { diagnosticErrorTags } from "./observability/sentryPrivacy";

describe("withKind", () => {
  it("keeps a named error and its identity", () => {
    const error = new AppError("google.auth_failed", "Rejected credential");
    expect(withKind(error, "google.api_failed", "Call failed")).toBe(error);
  });

  it("keeps a plain wrapper's stack when a cause already names the failure", () => {
    const cause = new AppError("google.auth_failed", "Rejected credential");
    const error = new Error("Wrapper", { cause });
    const failure = withKind(error, "google.api_failed", "Call failed");
    expect(failure).toBe(error);
    expect(failure.stack).toBe(error.stack);
    expect(diagnosticErrorTags(failure).error_kind).toBe("google.auth_failed");
  });

  it("wraps an unnamed Error without losing its dependency diagnostics", () => {
    const error = Object.assign(new Error("Database unavailable"), { code: "08006" });
    const failure = withKind(error, "db.query_failed", "Query failed");
    expect(failure).toBeInstanceOf(AppError);
    expect(failure.cause).toBe(error);
    expect(diagnosticErrorTags(failure)).toMatchObject({ error_kind: "db.query_failed", failure_code: "08006" });
  });

  it("wraps a non-Error with the supplied kind and original cause", () => {
    const cause = { code: "23505" };
    expect(withKind(cause, "db.query_failed", "Query failed")).toMatchObject({ kind: "db.query_failed", cause });
  });

  it("terminates on an unnamed cyclic cause chain", () => {
    const error = new Error("Cycle");
    error.cause = error;
    expect(withKind(error, "db.query_failed", "Query failed")).toMatchObject({ kind: "db.query_failed", cause: error });
  });
});
