import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { spreadsheetToLLMText } from "../spreadsheet";

// Excel declares an inflated used range (up to A1:XFD1048576) after
// whole-row formatting or one stray cell. Re-inflate the parsed range so the
// renderer sees what such a workbook looks like; the cells stay sparse.
const INFLATED_REF = "A1:Z20000";
vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>();
  return {
    ...actual,
    read: (...args: Parameters<typeof actual.read>) => {
      const workbook = actual.read(...args);
      for (const sheet of Object.values(workbook.Sheets)) sheet["!ref"] = INFLATED_REF;
      return workbook;
    },
  };
});

describe("spreadsheetToLLMText", () => {
  it("renders an inflated used range by visiting only the cells that exist", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Name", "Amount"], ["Rent", 1200]]);
    ws["!merges"] = [XLSX.utils.decode_range("A4:B4")];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Budget");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const encodeCell = vi.spyOn(XLSX.utils, "encode_cell");

    expect(spreadsheetToLLMText(buffer)).toBe(
      [
        "## Sheet: Budget",
        "",
        "| Row | A | B |",
        "| --- | --- | --- |",
        "| 1 | Name | Amount |",
        "| 2 | Rent | 1200 |",
        "| 4 | ⟨merged A4:B4⟩ |  |",
      ].join("\n"),
    );
    // Work scales with the few real cells, not the 520,000-cell rectangle.
    expect(encodeCell.mock.calls.length).toBeLessThan(100);
  });
});
