import { describe, expect, it } from "vitest";
import { ConversionError } from "../convert";
import { diagnosticErrorTags } from "../observability/sentryPrivacy";

describe("conversion identity", () => {
  it.each([
    ["conversion.unavailable", "conversion_unavailable"],
    ["conversion.timeout", "conversion_timeout"],
    ["conversion.failed", "conversion_failed"],
    ["conversion.no_output", "conversion_failed"],
  ] as const)("derives the compatible code for %s", (kind, code) => {
    const cause = new Error("private dependency detail");
    const error = new ConversionError(kind, "Conversion failed", { cause });
    expect(error.code).toBe(code);
    expect(error.cause).toBe(cause);
    expect(diagnosticErrorTags(error)).toMatchObject({ error_kind: kind, failure_code: code });
  });
});
