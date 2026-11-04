import { it as test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as X from "xlsx";
vi.mock("xlsx", async original => {
  const actual = await original<typeof import("xlsx")>();
  return { ...actual, read: vi.fn(actual.read) };
});
import { spreadsheetToValues as parsePreview, SpreadsheetValuesError as PreviewError, SPREADSHEET_VALUES_LIMITS as LIMITS } from "../spreadsheetValues";
import type { SpreadsheetValues } from "@mike/contracts";
const directory = path.join(__dirname, "fixtures/spreadsheetValues");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")) as {
  fixtures: Array<{id: string; sha256: string; expected: string}>;
};
const expectedCode: Record<string, string> = {
  malformed_workbook: "spreadsheet_values_malformed", preview_limit: "spreadsheet_values_limit",
  encrypted_workbook: "spreadsheet_values_encrypted", unsupported_format: "spreadsheet_values_unsupported",
};
const bytes = (id: string) => fs.readFileSync(path.join(directory, `${id}.xls`));
const hash = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const cell = (result: SpreadsheetValues, address: string) => result.sheets[0].cells.find(c => c.address === address)!;

for (const fixture of manifest.fixtures) {
  test(`fixture admission/hash: ${fixture.id} -> ${fixture.expected}`, () => {
    const input = bytes(fixture.id);
    assert.equal(hash(input), fixture.sha256);
    if (fixture.expected === 'ok') assert.equal(parsePreview(input).parserVersion, '0.20.3');
    else assert.throws(() => parsePreview(input), error => error instanceof PreviewError && error.code === expectedCode[fixture.expected]);
    assert.equal(hash(input), fixture.sha256, 'Parser must not alter original bytes.');
  });
}

test('preserves exact display text, coordinates and number formats without executing literal text', () => {
  const result = parsePreview(bytes('values-and-metadata'));
  const expected = { A1: '  leading and trailing  ', B1: 'line one\nline two',
    C1: '<script>synthetic-only</script>', A2: '12.5%', B2: '000123', C2: '2024-01-01',
    A3: 'Unicode Ω 中文', B3: '=1+2', A4: 'TRUE', A5: '#DIV/0!' };
  for (const [address, text] of Object.entries(expected)) assert.equal(cell(result, address).displayText, text);
  assert.equal(cell(result, 'B3').formulaStatus, 'none');
  assert.deepEqual(cell(result, 'C2'), { row: 1, column: 2, address: 'C2', displayText: '2024-01-01', kind: 'number', formulaStatus: 'none' });
  assert.deepEqual(result.sheets[0].range, { startRow: 0, startColumn: 0, endRow: 7, endColumn: 2 });
});

test('preserves stale cached 999 for real formula 1+2 and distinguishes a cached blank from missing', () => {
  const input = bytes('formula-caches');
  const raw = X.read(input, { type: 'buffer', cellFormula: true }).Sheets.Formula;
  assert.equal(raw.A1.f, '1+2'); assert.equal(raw.A1.v, 999);
  assert.equal(raw.A2.f, '1+2'); assert.equal(raw.A2.v, '');
  const result = parsePreview(input);
  assert.equal(cell(result, 'A1').displayText, '999');
  assert.equal(cell(result, 'A1').formulaStatus, 'cached');
  assert.equal(cell(result, 'A2').displayText, '');
  assert.equal(cell(result, 'A2').formulaStatus, 'cached');
  assert.equal(cell(result, 'A3').displayText, '=1+2');
  assert.equal(cell(result, 'A3').formulaStatus, 'none');
  assert.ok(result.warnings.some(w => w.includes('never recalculated')));
});

test('honors an encoded 1904 date system without shifting the stored date displays', () => {
  const input = bytes('date-system-1904');
  const raw = X.read(input, { type: 'buffer', cellNF: true });
  assert.equal(raw.Workbook?.WBProps?.date1904, true);
  assert.equal(raw.Sheets.Dates.A1.v, 0);
  assert.equal(raw.Sheets.Dates.A2.v, 43830);
  assert.equal((Date.UTC(2024, 0, 1) - Date.UTC(1904, 0, 1)) / 86_400_000, 43830);
  const result = parsePreview(input);
  assert.equal(cell(result, 'A1').displayText, '1904-01-01');
  assert.equal(cell(result, 'A2').displayText, '2024-01-01');
  assert.equal(cell(result, 'A2').formulaStatus, 'none');
});

test('retains nonzero coordinates across Z to AA and a 21-row used range', () => {
  const input = bytes('offset-range-z-aa');
  assert.equal(X.read(input, { type: 'buffer' }).Sheets.Offset['!ref'], 'Z8:AA28');
  const result = parsePreview(input);
  assert.deepEqual(result.sheets[0].range, { startRow: 7, startColumn: 25, endRow: 27, endColumn: 26 });
  assert.deepEqual(result.sheets[0].cells.map(c => [c.address, c.row, c.column]), [
    ['Z8', 7, 25], ['AA8', 7, 26], ['Z28', 27, 25], ['AA28', 27, 26],
  ]);
  assert.equal(cell(result, 'Z8').displayText, '000007');
  assert.equal(cell(result, 'AA28').displayText, '$12.50');
  assert.equal(cell(result, 'Z28').displayText, 'Last of 21 rows');
});

test('keeps merge and visibility metadata explicit, including empty sheets', () => {
  const result = parsePreview(bytes('values-and-metadata'));
  assert.deepEqual(result.sheets.map(s => s.visibility), ['visible', 'hidden', 'very-hidden', 'visible']);
  assert.deepEqual(result.sheets[0].hiddenRows, [1]);
  assert.deepEqual(result.sheets[0].hiddenColumns, [1]);
  assert.deepEqual(result.sheets[0].merges, [{ startRow: 5, startColumn: 0, endRow: 5, endColumn: 1 }]);
  assert.equal(result.sheets[3].range, null);
  assert.deepEqual(result.sheets[3].cells, []);
});

test('retains both original sheets in the distinct-name control', () => {
  const result = parsePreview(bytes('distinct-sheet-names'));
  assert.deepEqual(result.sheets.map(sheet => [sheet.name, sheet.cells[0].displayText]), [
    ['Alpha1', 'FIRST original sheet'], ['Alpha2', 'SECOND original sheet'],
  ]);
});

test.each(['duplicate-sheet-names', 'case-duplicate-sheet-names'])('rejects %s with a static malformed error instead of a false preview', id => {
  const input = bytes(id);
  const raw = X.read(input, { type: 'buffer' });
  assert.equal(raw.SheetNames.length, 2);
  assert.equal(raw.SheetNames[0].toLowerCase(), raw.SheetNames[1].toLowerCase());
  assert.throws(() => parsePreview(input), error => error instanceof PreviewError &&
    error.code === 'spreadsheet_values_malformed' && error.message === new PreviewError('spreadsheet_values_malformed').message);
});

test.each(['', null, 17])('rejects an invalid parsed sheet name %j before constructing output', name => {
  const lookup = vi.fn(() => undefined);
  vi.mocked(X.read).mockReturnValueOnce({ SheetNames: [name], Sheets: new Proxy({}, { get: lookup }) } as unknown as X.WorkBook);
  assert.throws(() => parsePreview(bytes('distinct-sheet-names')), error => error instanceof PreviewError && error.code === 'spreadsheet_values_malformed');
  assert.equal(lookup.mock.calls.length, 0, 'Invalid names must reject before any sheet lookup.');
});

test('serializes only allowlisted data fields; no formula expressions, HTML, links or macro blobs', () => {
  for (const id of ['values-and-metadata', 'formula-caches']) {
    const result = parsePreview(bytes(id));
    assert.deepEqual(Object.keys(result).sort(), ['parserVersion', 'sheets', 'warnings']);
    for (const sheet of result.sheets) {
      assert.deepEqual(Object.keys(sheet).sort(), ['cells', 'hiddenColumns', 'hiddenRows', 'merges', 'name', 'range', 'visibility']);
      for (const c of sheet.cells) assert.deepEqual(Object.keys(c).sort(), ['address', 'column', 'displayText', 'formulaStatus', 'kind', 'row']);
    }
    assert.ok(!JSON.stringify(result).includes('javascript:synthetic_only()'));
    assert.ok(!JSON.stringify(result).includes('vbaraw'));
  }
});

test('rejects oversized input before CFB parsing, without truncating it', () => {
  const input = Buffer.alloc(LIMITS.inputBytes + 1, 0x41);
  const before = hash(input);
  assert.throws(() => parsePreview(input), error => error instanceof PreviewError && error.code === 'spreadsheet_values_limit');
  assert.equal(hash(input), before);
});

test('rejects invalid API input, unsupported workbook version and ambiguous streams', () => {
  assert.throws(() => parsePreview(new Uint8Array([1]) as unknown as Buffer), error => error instanceof PreviewError && error.code === 'spreadsheet_values_malformed');
  const input = bytes('formula-caches');
  const cfb = X.CFB.read(input, { type: 'buffer' });
  const stream = Buffer.from(X.CFB.find(cfb, 'Workbook').content);
  const biff5 = Buffer.from(stream); biff5.writeUInt16LE(0x0500, 4);
  X.CFB.utils.cfb_add(cfb, 'Workbook', biff5);
  assert.throws(() => parsePreview(X.CFB.write(cfb, { type: 'buffer' })), error => error instanceof PreviewError && error.code === 'spreadsheet_values_unsupported');
  X.CFB.utils.cfb_add(cfb, 'Workbook', stream);
  X.CFB.utils.cfb_add(cfb, 'Book', stream);
  assert.throws(() => parsePreview(X.CFB.write(cfb, { type: 'buffer' })), error => error instanceof PreviewError && error.code === 'spreadsheet_values_malformed');
});

test('rejects an encryption-marked CFB package without trying passwords or content parsing', () => {
  const cfb = X.CFB.utils.cfb_new();
  X.CFB.utils.cfb_add(cfb, 'EncryptionInfo', Buffer.from('synthetic-marker-only'));
  X.CFB.utils.cfb_add(cfb, 'EncryptedPackage', Buffer.from('not-a-real-encrypted-workbook'));
  assert.throws(() => parsePreview(X.CFB.write(cfb, { type: 'buffer' })), error => error instanceof PreviewError && error.code === 'spreadsheet_values_encrypted');
});

test.each(["container", "coordinates"] as const)("classifies a caught %s allocation failure as a safe resource-limit error", (stage) => {
  const error = new RangeError("Array buffer allocation failed: synthetic content must not leave the parser");
  const spy = stage === "container" ? vi.spyOn(X.CFB, "read").mockImplementationOnce(() => { throw error; }) :
    vi.spyOn(X.utils, "decode_cell").mockImplementationOnce(() => { throw error; });
  try {
    assert.throws(() => parsePreview(bytes("values-and-metadata")), caught =>
      caught instanceof PreviewError && caught.code === "spreadsheet_values_limit" && !caught.message.includes("synthetic content"));
  } finally { spy.mockRestore(); }
});
