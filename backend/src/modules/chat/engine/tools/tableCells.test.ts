import { describe, expect, it } from "vitest";
import { renderTableCells } from "./tableCells";
import type { TabularCellStore } from "../types";

describe("renderTableCells", () => {
  it("resolves row positions without rescanning the rows per cell", () => {
    let idReads = 0;
    const documents = Array.from({ length: 400 }, (_, i) => ({
      get id() {
        idReads++;
        return `doc-${i}`;
      },
      filename: `f${i}.pdf`,
    }));
    const store: TabularCellStore = {
      columns: [
        { index: 0, name: "Parties" },
        { index: 1, name: "Term" },
      ],
      documents,
      cells: new Map([["1:doc-399", { summary: "Two years" }]]),
    };
    const { label, content } = renderTableCells(store, [1], undefined);
    expect(label).toBe("1 column × 400 rows");
    expect(content).toContain('[COL:1 "Term" | ROW:399 "f399.pdf"]\nSummary: Two years');
    // One read per row to index, one per emitted cell; a findIndex per cell
    // reads ~R²/2 = 80,000 ids.
    expect(idReads).toBeLessThanOrEqual(800);
  });
});
