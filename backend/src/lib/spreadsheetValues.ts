import * as XLSX from "xlsx";
import type { SpreadsheetValues, SpreadsheetValueCell, SpreadsheetValueRange } from "@mike/contracts";
import { SpreadsheetValuesError, SPREADSHEET_VALUES_LIMITS as LIMITS, isAllocationFailure, type SpreadsheetValuesErrorCode } from "./extraction/limits";

export { SpreadsheetValuesError, SPREADSHEET_VALUES_LIMITS } from "./extraction/limits";
const KINDS: Record<string, SpreadsheetValueCell["kind"]> = { n: "number", s: "text", b: "boolean", e: "error", z: "blank" };
const OLE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

type Failure = "invalid_input" | "unsupported_format" | "encrypted_workbook" | "malformed_workbook" | "preview_limit";
const CODES: Record<Failure, SpreadsheetValuesErrorCode> = {
  invalid_input: "spreadsheet_values_malformed", unsupported_format: "spreadsheet_values_unsupported",
  encrypted_workbook: "spreadsheet_values_encrypted", malformed_workbook: "spreadsheet_values_malformed",
  preview_limit: "spreadsheet_values_limit",
};
function fail(code: Failure): never { throw new SpreadsheetValuesError(CODES[code]); }
function malformed(): never { return fail("malformed_workbook"); }
function limit(): never { return fail("preview_limit"); }

// Inspect the actual CFB stream and BIFF record framing before SheetJS. This is
// admission validation, not a replacement for a complete Office-file validator.
function inspectWorkbook(buffer: Buffer): void {
  if (!buffer.subarray(0, 8).equals(OLE)) fail('unsupported_format');
  let cfb: { FullPaths: string[]; FileIndex: { type: number; content: Uint8Array }[] };
  try { cfb = XLSX.CFB.read(buffer, { type: 'buffer' }); }
  catch (error) { if (isAllocationFailure(error)) limit(); malformed(); }
  const root = cfb.FullPaths[0];
  const rootEntries = cfb.FullPaths.map((name, i) => ({ name, entry: cfb.FileIndex[i] }));
  if (rootEntries.some(({ name }) => name === `${root}EncryptedPackage` || name === `${root}EncryptionInfo`)) {
    fail('encrypted_workbook');
  }
  const entries = rootEntries.filter(({ name, entry }) => entry.type === 2 &&
    (name === `${root}Workbook` || name === `${root}Book`));
  if (entries.length !== 1) malformed();
  const stream = Buffer.from(entries[0].entry.content);
  if (stream.length < 8 || stream.readUInt16LE(0) !== 0x0809 ||
      stream.readUInt16LE(2) < 4 || stream.readUInt16LE(4) !== 0x0600 || stream.readUInt16LE(6) !== 5) {
    fail('unsupported_format');
  }
  let offset = 0, open = false, substreams = 0;
  while (offset < stream.length) {
    if (offset + 4 > stream.length) malformed();
    const id = stream.readUInt16LE(offset), size = stream.readUInt16LE(offset + 2);
    if (id === 0 && size === 0) {
      if (open || !stream.subarray(offset).every(value => value === 0)) malformed();
      break;
    }
    const end = offset + 4 + size;
    if (end > stream.length) malformed();
    if (id === 0x002f) fail('encrypted_workbook');
    if (id === 0x0809) {
      if (open) fail('unsupported_format');
      if (size < 4 || stream.readUInt16LE(offset + 4) !== 0x0600) malformed();
      const type = stream.readUInt16LE(offset + 6);
      if (type !== (substreams === 0 ? 5 : 0x10)) fail('unsupported_format');
      open = true; substreams++;
    } else if (!open) malformed();
    if (id === 0x000a) { if (size !== 0) malformed(); open = false; }
    if (id === 0x0006) {
      if (size < 22 || stream.readUInt16LE(offset + 4 + 20) > size - 22) malformed();
      const result = offset + 4 + 6;
      if (stream.readUInt16LE(result + 6) === 0xffff) {
        const type = stream[result];
        if (type > 3) malformed();
        // A valid blank-string cache (type 3) is present, not missing. A
        // string-result marker (type 0) requires its following String record.
        if (type === 0 && (end + 4 > stream.length || stream.readUInt16LE(end) !== 0x0207)) malformed();
      } else if (!Number.isFinite(stream.readDoubleLE(result))) malformed();
    }
    offset = end;
  }
  if (open || substreams < 2) malformed();
}

function address(value: string): XLSX.CellAddress {
  if (!/^[A-Z]{1,2}[1-9][0-9]{0,4}$/.test(value)) malformed();
  const point = XLSX.utils.decode_cell(value);
  if (point.r > 65535 || point.c > 255) malformed();
  return point;
}
function range(value: unknown): SpreadsheetValueRange {
  if (typeof value !== 'string') malformed();
  const parts = value.split(':');
  if (parts.length > 2) malformed();
  const s = address(parts[0]), e = address(parts[1] || parts[0]);
  if (e.r < s.r || e.c < s.c) malformed();
  return { startRow: s.r, startColumn: s.c, endRow: e.r, endColumn: e.c };
}
function checkRange(value: SpreadsheetValueRange): void {
  if (value.endRow - value.startRow + 1 > LIMITS.rows ||
      value.endColumn - value.startColumn + 1 > LIMITS.columns) limit();
}
function cellText(cell: XLSX.CellObject): string {
  if (typeof cell.w === 'string') return cell.w;
  if (cell.v == null) return '';
  if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
  if (typeof cell.v === 'string' || typeof cell.v === 'number' && Number.isFinite(cell.v)) return String(cell.v);
  malformed();
}

function buildPreview(buffer: Buffer): SpreadsheetValues {
  if (!Buffer.isBuffer(buffer)) fail('invalid_input');
  if (!buffer.length) malformed();
  if (buffer.length > LIMITS.inputBytes) limit();
  if (XLSX.version !== '0.20.3') throw new SpreadsheetValuesError("spreadsheet_values_unavailable");
  inspectWorkbook(buffer);
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellHTML: false,
      cellNF: true, cellStyles: true, cellText: true, cellDates: false, sheetStubs: true,
      bookVBA: false, bookDeps: false, WTF: true });
  } catch (error) { if (isAllocationFailure(error)) limit(); malformed(); }
  if (!Array.isArray(wb.SheetNames) || !wb.SheetNames.length) malformed();
  if (wb.SheetNames.length > LIMITS.sheets) limit();
  // SheetJS indexes worksheets by name. Duplicate names can overwrite a sheet's
  // values before we see them; never present that ambiguous result as complete.
  const names = new Set<string>();
  for (const name of wb.SheetNames) {
    if (typeof name !== 'string' || !name.length) malformed();
    const key = name.toLowerCase();
    if (names.has(key)) malformed();
    names.add(key);
  }
  let count = 0, area = 0;
  const sheets = wb.SheetNames.map((name, index) => {
    const ws = wb.Sheets[name];
    if (!ws || typeof name !== 'string') malformed();
    const cellKeys = Object.keys(ws).filter(key => !key.startsWith('!'));
    const mergeList = ws['!merges'] || [];
    if (!Array.isArray(mergeList) || mergeList.length > LIMITS.cells) limit();
    // Empty BIFF worksheets can carry a default A1 dimension but no cells.
    const used = cellKeys.length || mergeList.length ? range(ws['!ref']) : null;
    const merges = mergeList.map(m => {
      const value = { startRow: m.s.r, startColumn: m.s.c, endRow: m.e.r, endColumn: m.e.c };
      if (!Object.values(value).every(Number.isSafeInteger) || value.startRow < 0 || value.startColumn < 0 ||
          value.endRow < value.startRow || value.endColumn < value.startColumn || value.endRow > 65535 || value.endColumn > 255) malformed();
      checkRange(value);
      if (!used || value.startRow < used.startRow || value.startColumn < used.startColumn ||
          value.endRow > used.endRow || value.endColumn > used.endColumn) {
        fail('unsupported_format');
      }
      return value;
    });
    if (used) {
      checkRange(used);
      area += (used.endRow - used.startRow + 1) * (used.endColumn - used.startColumn + 1);
      if (area > LIMITS.renderedCells) limit();
    }
    const cells: SpreadsheetValueCell[] = [];
    for (const key of cellKeys) {
      const p = address(key), cell = ws[key];
      if (!used || p.r < used.startRow || p.r > used.endRow || p.c < used.startColumn || p.c > used.endColumn || !cell || typeof cell !== 'object') malformed();
      if (++count > LIMITS.cells) limit();
      const formula = typeof cell.f === 'string' || typeof cell.F === 'string';
      const formulaStatus = formula ? cell.v == null ? 'missing' : 'cached' : 'none';
      const displayText = cellText(cell);
      if (Buffer.byteLength(displayText, 'utf8') > LIMITS.textBytes) limit();
      cells.push({ row: p.r, column: p.c, address: key, displayText,
        kind: formula ? 'formula' : (KINDS[cell.t] || 'text'), formulaStatus });
    }
    cells.sort((a, b) => a.row - b.row || a.column - b.column);
    const hidden = (entries: Array<{ hidden?: boolean } | undefined> | undefined, start: number, end: number) => Object.keys(entries || {}).map(Number)
      .filter(i => Number.isSafeInteger(i) && i >= start && i <= end && entries?.[i]?.hidden).sort((a, b) => a - b);
    const visibility = (['visible', 'hidden', 'very-hidden'] as const)[wb.Workbook?.Sheets?.[index]?.Hidden || 0];
    if (!visibility) malformed();
    return { name, visibility, range: used, merges,
      hiddenRows: used ? hidden(ws['!rows'], used.startRow, used.endRow) : [],
      hiddenColumns: used ? hidden(ws['!cols'], used.startColumn, used.endColumn) : [], cells };
  });
  const result: SpreadsheetValues = { parserVersion: XLSX.version, sheets, warnings: [
    'Values-only prototype: styling, charts, images, comments, links and macros are not displayed.',
    'Formula values are stored caches: they may be stale and are never recalculated.',
    'Hidden sheet, row and column metadata is labelled; this preview does not change original bytes.',
  ] };
  if (sheets.some(s => s.cells.some(c => c.formulaStatus === 'missing'))) result.warnings.push('Some formula cells have no usable cached result.');
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIMITS.outputBytes) limit();
  return result;
}

export function spreadsheetToValues(buffer: Buffer): SpreadsheetValues {
  try { return buildPreview(buffer); }
  catch (error) {
    if (error instanceof SpreadsheetValuesError) throw error;
    if (isAllocationFailure(error)) limit();
    // Dependency exceptions can include source-derived content. Only stable,
    // source-authored failure messages cross this prototype boundary.
    malformed();
  }
}
