import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runIsolatedExtraction, stopExtractionProcess, SpreadsheetValuesError,
  SPREADSHEET_VALUES_MAX_BYTES } from "../isolated";
import { assertSpreadsheetValuesOutputBudget, SPREADSHEET_VALUES_LIMITS,
  spreadsheetValuesFailureReply, isSpreadsheetValuesErrorCode } from "../limits";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const fixture = (name: string) => Uint8Array.from(readFileSync(path.join(__dirname,
  "../../__tests__/fixtures/spreadsheetValues", `${name}.xls`))).buffer;
beforeEach(() => { vi.stubEnv("EXTRACTION_ISOLATION", "on"); vi.mocked(spawn).mockClear(); });
afterEach(async () => { await stopExtractionProcess(); vi.unstubAllEnvs(); });

describe("structured spreadsheet preview isolation", () => {
  it("returns a real structured BIFF8 preview from the child without formula expressions", async () => {
    const result = await runIsolatedExtraction("spreadsheetValues", async () => fixture("formula-caches"));
    expect(spawn).toHaveBeenCalledOnce();
    expect(result.sheets[0].cells).toMatchObject([
      { displayText: "999", formulaStatus: "cached" },
      { displayText: "", formulaStatus: "cached" },
      { displayText: "=1+2", formulaStatus: "none" },
    ]);
    expect(result.sheets[0].cells.every(cell => !Object.hasOwn(cell, "f"))).toBe(true);
  });

  it.each([
    ["corrupt", "spreadsheet_values_unsupported"],
    ["missing-string-cache", "spreadsheet_values_malformed"],
    ["encryption-marked", "spreadsheet_values_encrypted"],
    ["sparse-area-limit", "spreadsheet_values_limit"],
    ["output-limit", "spreadsheet_values_limit"],
  ])("preserves %s admission failures as typed source-authored errors across IPC", async (name, code) => {
    const error = await runIsolatedExtraction("spreadsheetValues", async () => fixture(name)).catch(error => error);
    expect(error).toBeInstanceOf(SpreadsheetValuesError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(new SpreadsheetValuesError(code as SpreadsheetValuesError["code"]).message);
    await expect(runIsolatedExtraction("spreadsheetValues", async () => fixture("formula-caches"))).resolves.toMatchObject({ parserVersion: "0.20.3" });
  });

  it("refuses the isolation-off bypass without spawning or importing an in-process parser", async () => {
    vi.stubEnv("EXTRACTION_ISOLATION", "off");
    await expect(runIsolatedExtraction("spreadsheetValues", async () => fixture("formula-caches")))
      .rejects.toMatchObject({ code: "spreadsheet_values_unavailable" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("enforces the smaller input budget before starting a child", async () => {
    await expect(runIsolatedExtraction("spreadsheetValues", async () => new ArrayBuffer(SPREADSHEET_VALUES_MAX_BYTES + 1)))
      .rejects.toMatchObject({ code: "spreadsheet_values_limit" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills an overdue preview and recovers with a fresh child", async () => {
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "1");
    await expect(runIsolatedExtraction("spreadsheetValues", async () => fixture("formula-caches")))
      .rejects.toMatchObject({ code: "spreadsheet_values_limit" });
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "60000");
    await expect(runIsolatedExtraction("spreadsheetValues", async () => fixture("formula-caches")))
      .resolves.toMatchObject({ parserVersion: "0.20.3" });
  });

  it("bounds the complete serialized result before IPC rather than just a text property", () => {
    const max = SPREADSHEET_VALUES_LIMITS.outputBytes;
    expect(() => assertSpreadsheetValuesOutputBudget({ text: "", cells: ["X".repeat(max)] }))
      .toThrow(SpreadsheetValuesError);
    expect(() => assertSpreadsheetValuesOutputBudget({ text: "", cells: ["文".repeat(Math.ceil(max / 3))] }))
      .toThrow(SpreadsheetValuesError);
    expect(() => assertSpreadsheetValuesOutputBudget("X".repeat(max - 2))).not.toThrow();
    expect(() => assertSpreadsheetValuesOutputBudget("X".repeat(max - 1))).toThrow(SpreadsheetValuesError);
    expect(() => assertSpreadsheetValuesOutputBudget(undefined)).toThrow(SpreadsheetValuesError);
  });

  it("does not transmit raw dependency messages or mutated error messages", () => {
    const secret = "synthetic workbook content must never appear in IPC failure text";
    expect(spreadsheetValuesFailureReply(new Error(secret))).toEqual({
      ok: false, limited: false, code: "spreadsheet_values_malformed",
      message: new SpreadsheetValuesError("spreadsheet_values_malformed").message,
    });
    const typed = new SpreadsheetValuesError("spreadsheet_values_encrypted");
    typed.message = secret;
    expect(spreadsheetValuesFailureReply(typed).message).not.toContain(secret);
    expect(spreadsheetValuesFailureReply({ code: secret, message: secret }).code).toBe("spreadsheet_values_malformed");
    expect(isSpreadsheetValuesErrorCode("__proto__")).toBe(false);
    expect(isSpreadsheetValuesErrorCode(secret)).toBe(false);
    expect(spreadsheetValuesFailureReply(new RangeError("Array buffer allocation failed")))
      .toMatchObject({ code: "spreadsheet_values_limit", limited: true });
  });

  it("ignores an unknown IPC error code and source-derived message", async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementationOnce((...args: Parameters<typeof spawn>) => {
      const child = realSpawn(...args);
      child.once("spawn", () => child.emit("message", {
        ok: false, limited: false, code: "__proto__", message: "synthetic private workbook content",
      }));
      return child;
    });
    const error = await runIsolatedExtraction("spreadsheetValues", async () => fixture("formula-caches")).catch(error => error);
    expect(error).toBeInstanceOf(SpreadsheetValuesError);
    expect(error.code).toBe("spreadsheet_values_malformed");
    expect(error.message).toBe(new SpreadsheetValuesError("spreadsheet_values_malformed").message);
  });
});
