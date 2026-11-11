// @vitest-environment node
import ExcelJS from "exceljs";
import { afterEach, expect, it, vi } from "vitest";
import { assertExcelRowFits, buildTabularReviewWorkbook, exportTabularReviewToExcel } from "./exportToExcel";
import type { TabularCell, TabularReviewRow } from "../shared/types";

const row: TabularReviewRow = {
    id: "fictional-row-a", review_id: "fictional-review", label: "FICTIONAL Contract A",
    row_type: "document", folder_id: null, library_folder_id: null,
    document_id: "fictional-doc-a", sort_index: 0, source_document_ids: ["fictional-doc-a"],
};
const cell: TabularCell = {
    id: "fictional-answer", review_id: row.review_id, row_id: row.id,
    document_id: row.document_id, column_index: 7, status: "done", created_at: "",
    content: { summary: "90 days [[document:fictional-doc-a||page:3||quote:FICTIONAL: give 90 days notice.]]", flag: "green", reasoning: "FICTIONAL assessment" },
};
const params = {
    reviewTitle: "FICTIONAL handover", columns: [{ index: 7, name: "FICTIONAL Notice", prompt: "" }],
    rows: [row, { ...row, id: "fictional-row-b", label: "FICTIONAL Contract B" }],
    cells: [cell, { ...cell, id: "fictional-pending", row_id: "fictional-row-b", status: "generating" as const, content: null }],
    documents: [{ id: "fictional-doc-a", filename: "FICTIONAL Contract A.pdf" }],
};

async function download(input = params) {
    let blob: Blob | undefined;
    const click = vi.fn();
    vi.stubGlobal("document", { createElement: () => ({ click, remove() {}, href: "", download: "" }), body: { appendChild() {} } });
    vi.spyOn(URL, "createObjectURL").mockImplementation((value: Blob | MediaSource) => { blob = value as Blob; return "blob:fictional"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await exportTabularReviewToExcel(input);
    expect(click).toHaveBeenCalledOnce();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blob!.arrayBuffer());
    return wb;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("refuses oversized supplied text before creating a download instead of truncating", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await expect(download({ ...params, cells: [{ ...cell,
        content: { summary: "x".repeat(32768) },
    }] })).rejects.toThrow("32,767");
    expect(createUrl).not.toHaveBeenCalled();
});

it("downloads unchanged Review answers plus supporting quotations and completion state", async () => {
    const wb = await download();
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Review", "Evidence"]);
    expect(wb.worksheets[0].getSheetValues()).toEqual([
        undefined, [undefined, "Folder / document", "FICTIONAL Notice"],
        [undefined, "FICTIONAL Contract A", "90 days"], [undefined, "FICTIONAL Contract B", ""],
    ]);
    const evidence = wb.getWorksheet("Evidence")!;
    const headers = evidence.getRow(1).values as string[];
    const value = (r: number, name: string) => evidence.getRow(r).getCell(headers.indexOf(name)).value;
    expect(value(2, "Answer address")).toBe("Review!B2");
    expect(value(2, "Quotation")).toBe("FICTIONAL: give 90 days notice.");
    expect(value(2, "Source filename")).toBe("FICTIONAL Contract A.pdf");
    expect(value(2, "Page")).toBe(3);
    expect(value(3, "Stored status")).toBe("generating");
});

function evidenceRecords(wb: ExcelJS.Workbook) {
    const ws = wb.getWorksheet("Evidence")!;
    const headers = ws.getRow(1).values as string[];
    return Array.from({ length: ws.rowCount - 1 }, (_, i) => Object.fromEntries(
        headers.slice(1).map((name, j) => [name, ws.getRow(i + 2).getCell(j + 1).value]),
    ));
}

it("preserves every status, absent records, null content and done-empty separately", async () => {
    const statuses = ["pending", "generating", "error", "done", "done"] as const;
    const flags = ["green", "grey", "yellow", "red"] as const;
    const rows = Array.from({ length: 6 }, (_, i) => ({ ...row, id: `fictional-${i}`, label: "FICTIONAL duplicate" }));
    const cells = statuses.map((status, i) => ({ ...cell, id: `fictional-cell-${i}`, row_id: rows[i].id, status,
        content: i === 4 ? null : { summary: "", flag: flags[i], reasoning: `FICTIONAL reason ${i}` },
    }));
    const wb = await download({ ...params, rows, cells });
    const records = evidenceRecords(wb);
    expect(records.map((r) => r["Stored status"])).toEqual([...statuses, ""]);
    expect(records.map((r) => r.Record)).toEqual(["Present", "Present", "Present", "Present", "Present", "Absent"]);
    expect(records.map((r) => r.Content)).toEqual(["Present", "Present", "Present", "Present", "Null", "Absent"]);
    expect(records.slice(0, 4).map((r) => r.Flag)).toEqual(flags);
    expect(records[3].Reasoning).toBe("FICTIONAL reason 3");
    expect(records[5]["Cell ID"]).toBe("");
    expect(wb.getWorksheet("Review")!.getColumn(2).values.slice(2)).toEqual(["", "", "Error", "", "", ""]);
});

it("keeps ordered summary citations, IDs and locators without guessing multi-source filenames", async () => {
    const summary = "FICTIONAL [[document:fictional-b||sheet:Résumé||row:7||col:C||quote:第二行\nFictional]] " +
        "[[page:2||quote:FICTIONAL legacy]] [[document:fictional-hidden||page:9||quote:FICTIONAL missing]]";
    const rows = [{ ...row, source_document_ids: ["fictional-b", "fictional-doc-a"] }, { ...row, id: "fictional-other", label: row.label }];
    const columns = [{ index: 7, name: "FICTIONAL duplicate", prompt: "" }, { index: 2, name: "FICTIONAL duplicate", prompt: "" }];
    const wb = await download({ ...params, rows, columns, cells: [
        { ...cell, content: { summary, reasoning: "FICTIONAL [[page:8||quote:reason only]]" } },
        { ...cell, row_id: "fictional-other", content: { summary: "FICTIONAL [[page:5||quote:single source]] [[unknown:FICTIONAL]] [[red]]" } },
    ], documents: [{ id: "fictional-doc-a", filename: "FICTIONAL duplicate.pdf" }, { id: "fictional-b", filename: "FICTIONAL duplicate.pdf" }] });
    const records = evidenceRecords(wb);
    expect(records.map((r) => r["Answer address"])).toEqual(["Review!B2", "Review!C2", "Review!C2", "Review!C2", "Review!B3", "Review!C3"]);
    expect(records.map((r) => r["Column index"])).toEqual([2, 7, 7, 7, 2, 7]);
    expect(records.slice(1, 4).map((r) => r["Citation number"])).toEqual([1, 2, 3]);
    expect(records[1]["Location"]).toBe("C7");
    expect(records[1].Sheet).toBe("Résumé");
    expect(records[1].Quotation).toBe("第二行\nFictional");
    expect(records[1]["Source document ID"]).toBe("fictional-b");
    expect(records[1]["Source filename"]).toBe("FICTIONAL duplicate.pdf");
    expect(records[1]["Raw summary"]).toBe(summary);
    expect(records[1]["Row source IDs (JSON)"]).toBe(JSON.stringify(rows[0].source_document_ids));
    expect(records[2]["Source document ID"]).toBe("");
    expect(records[2]["Source resolution"]).toContain("Unresolved");
    expect(records[3]["Citation document ID"]).toBe("fictional-hidden");
    expect(records[3]["Source filename"]).toBe("");
    expect(records[3]["Source resolution"]).toContain("metadata not supplied");
    expect(records[5]["Source document ID"]).toBe("fictional-doc-a");
    expect(records[5]["Source resolution"]).toBe("Inferred from single-source row");
    expect(records[5]["Raw summary"]).toContain("[[unknown:FICTIONAL]]");
});

it.each(["=1+1", "+FICTIONAL", "-FICTIONAL", "@FICTIONAL", "FICTIONAL 日本語\n😀"])("round trips untrusted %s as text, never formulas", async (text: string) => {
    const summary = `${text} [[page:1||quote:${text}]]`;
    const wb = await download({ ...params, columns: [{ index: 7, name: text, prompt: "" }],
        rows: [{ ...row, id: text, label: text, source_document_ids: [text] }],
        cells: [{ ...cell, id: text, row_id: text, content: { summary, reasoning: text } }],
        documents: [{ id: text, filename: text }],
    });
    const records = evidenceRecords(wb);
    expect(records[0]["Raw summary"]).toBe(summary);
    expect(records[0]["Source filename"]).toBe(text);
    expect(records[0].Quotation).toBe(text);
    expect(records[0].Reasoning).toBe(text);
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => {
        expect(c.type).not.toBe(ExcelJS.ValueType.Formula);
    })));
    expect(wb.getWorksheet("Review")!.getCell("B2").type).toBe(ExcelJS.ValueType.String);
});

it("accepts exact text limit and refuses oversized raw unfinished content, labels, names and metadata", async () => {
    const text = "x".repeat(32767);
    const wb = await download({ ...params, cells: [{ ...cell, content: { summary: text } }] });
    expect(evidenceRecords(wb)[0]["Raw summary"]).toBe(text);
    const tooLong = text + "x";
    for (const input of [
        { ...params, cells: [{ ...cell, status: "pending" as const, content: { summary: tooLong } }] },
        { ...params, rows: [{ ...row, label: tooLong }] },
        { ...params, columns: [{ index: 7, name: tooLong, prompt: "" }] },
        { ...params, documents: [{ id: "fictional-doc-a", filename: tooLong }] },
        { ...params, cells: [{ ...cell, content: { summary: "", reasoning: tooLong } }] },
    ]) expect(() => buildTabularReviewWorkbook(input)).toThrow("32,767");
});

it("checks inclusive worksheet bounds with small allocations", () => {
    expect(() => assertExcelRowFits(["FICTIONAL"], 1048576)).not.toThrow();
    expect(() => assertExcelRowFits(["FICTIONAL"], 1048577)).toThrow("1,048,576");
    expect(() => assertExcelRowFits(Array(16384).fill(""), 1)).not.toThrow();
    expect(() => assertExcelRowFits(Array(16385).fill(""), 1)).toThrow("16,384");
    expect(() => buildTabularReviewWorkbook({ ...params, rows: Array(1048576) })).toThrow("1,048,576");
});

it("applies expanded Evidence row refusal to the real exporter before download", async () => {
    const prototype = Object.getPrototypeOf(buildTabularReviewWorkbook(params).getWorksheet("Evidence"));
    const getter = Object.getOwnPropertyDescriptor(prototype, "rowCount")!.get!;
    vi.spyOn(prototype, "rowCount", "get").mockImplementation(function (this: ExcelJS.Worksheet) {
        return this.name === "Evidence" ? 1048576 : getter.call(this);
    });
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await expect(exportTabularReviewToExcel(params)).rejects.toThrow("1,048,576");
    expect(createUrl).not.toHaveBeenCalled();
});


it("leaves no-source citations unresolved and retains unparsed summaries without inventing quotations", async () => {
    const raw = "FICTIONAL [[unsupported:legacy]] [[page:bad||quote:not recognized]] [[red]]";
    const wb = await download({ ...params, rows: [{ ...row, source_document_ids: [] }],
        columns: [params.columns[0], { index: 9, name: "FICTIONAL unknown", prompt: "" }], cells: [
            { ...cell, content: { summary: "FICTIONAL [[page:1||quote:no source ID]]" } },
            { ...cell, column_index: 9, content: { summary: raw } },
        ],
    });
    const records = evidenceRecords(wb);
    expect(records[0]["Source document ID"]).toBe("");
    expect(records[0]["Source filename"]).toBe("");
    expect(records[0]["Source resolution"]).toContain("Unresolved");
    expect(records[1]["Raw summary"]).toBe(raw);
    expect(records[1].Quotation).toBe("");
    expect(records[1]["Citation number"]).toBe("");
});

it("browser-mode ExcelJS preserves supplementary Unicode at the conservative text boundary", async () => {
    // This is a client-only exporter. ExcelJS uses TextEncoder for process.browser;
    // its Node-only JSZip string encoder can split surrogate pairs across chunks.
    const browserProcess = process as NodeJS.Process & { browser?: boolean };
    const previous = browserProcess.browser;
    browserProcess.browser = true;
    try {
        const text = "😀".repeat(16383) + "x";
        const wb = await download({ ...params, cells: [{ ...cell, content: { summary: text } }] });
        expect(evidenceRecords(wb)[0]["Raw summary"]).toBe(text);
        expect(() => buildTabularReviewWorkbook({ ...params, cells: [{ ...cell, content: { summary: text + "x" } }] })).toThrow("32,767");
    } finally {
        if (previous === undefined) Reflect.deleteProperty(browserProcess, "browser");
        else browserProcess.browser = previous;
    }
});
