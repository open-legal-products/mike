'use strict';
// Original synthetic data only. No client files or copied vendor fixtures.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const X = require('xlsx');
const directory = __dirname;
fs.mkdirSync(directory, { recursive: true });
const fixtures = [];
function save(id, bytes, purpose, expected = 'ok') {
  fs.writeFileSync(path.join(directory, `${id}.xls`), bytes);
  fixtures.push({ id, filename: `${id}.xls`, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), purpose, expected });
}
function write(sheets, metadata, properties) {
  return X.write({ SheetNames: Object.keys(sheets), Sheets: sheets,
    Workbook: { Sheets: metadata || Object.keys(sheets).map(name => ({ name, Hidden: 0 })),
      ...(properties ? { WBProps: properties } : {}) } },
  { type: 'buffer', bookType: 'biff8', cellStyles: true });
}
function streamEdit(bytes, edit, streamName = 'Workbook') {
  const cfb = X.CFB.read(bytes, { type: 'buffer' });
  const content = Buffer.from(X.CFB.find(cfb, 'Workbook').content);
  X.CFB.utils.cfb_add(cfb, streamName, edit(content));
  if (streamName !== 'Workbook') X.CFB.utils.cfb_del(cfb, 'Workbook');
  return X.CFB.write(cfb, { type: 'buffer' });
}
function insertRecord(stream, position, record) {
  // Keep subsequent BoundSheet absolute stream positions correct.
  const adjusted = Buffer.from(stream);
  let offset = 0;
  while (offset + 4 <= adjusted.length) {
    const id = adjusted.readUInt16LE(offset), size = adjusted.readUInt16LE(offset + 2);
    if (id === 0x0085 && adjusted.readUInt32LE(offset + 4) >= position) {
      adjusted.writeUInt32LE(adjusted.readUInt32LE(offset + 4) + record.length, offset + 4);
    }
    offset += 4 + size;
  }
  return Buffer.concat([adjusted.subarray(0, position), record, adjusted.subarray(position)]);
}

const values = {
  A1: { t: 's', v: '  leading and trailing  ' },
  B1: { t: 's', v: 'line one\nline two' },
  C1: { t: 's', v: '<script>synthetic-only</script>' },
  A2: { t: 'n', v: 0.125, z: '0.0%' },
  B2: { t: 'n', v: 123, z: '000000' },
  C2: { t: 'n', v: 45292, z: 'yyyy-mm-dd' },
  A3: { t: 's', v: 'Unicode Ω 中文' },
  B3: { t: 's', v: '=1+2' },
  C3: { t: 's', v: 'Synthetic hyperlink text', l: { Target: 'javascript:synthetic_only()' } },
  A4: { t: 'b', v: true }, A5: { t: 'e', v: 7 },
  A6: { t: 's', v: 'Merged anchor' }, A8: { t: 's', v: 'Final row' },
  '!ref': 'A1:C8', '!merges': [X.utils.decode_range('A6:B6')],
  '!rows': [{}, { hidden: true }], '!cols': [{}, { hidden: true }],
};
let valuesBytes = write({ Values: values, Hidden: X.utils.aoa_to_sheet([['Synthetic hidden data']]),
  VeryHidden: X.utils.aoa_to_sheet([['Synthetic very-hidden data']]), Empty: {} },
[{ name: 'Values', Hidden: 0 }, { name: 'Hidden', Hidden: 1 }, { name: 'VeryHidden', Hidden: 2 }, { name: 'Empty', Hidden: 0 }]);
// CE's BIFF8 writer does not emit row visibility, so add a genuine ROW record.
valuesBytes = streamEdit(valuesBytes, stream => {
  let offset = 0;
  while (offset + 8 <= stream.length) {
    const id = stream.readUInt16LE(offset), size = stream.readUInt16LE(offset + 2);
    if (id === 0x0809 && stream.readUInt16LE(offset + 6) === 0x10) {
      const row = Buffer.alloc(20);
      row.writeUInt16LE(0x0208, 0); row.writeUInt16LE(16, 2);
      row.writeUInt16LE(1, 4); row.writeUInt16LE(3, 8); row.writeUInt16LE(300, 10);
      row[16] = 0x20;
      return insertRecord(stream, offset + 4 + size, row);
    }
    offset += 4 + size;
  }
  throw Error('Worksheet stream not found.');
});
if (!X.read(valuesBytes, { type: 'buffer', cellStyles: true }).Sheets.Values['!rows'][1].hidden) throw Error('Hidden row fixture did not round-trip.');
save('values-and-metadata', valuesBytes, 'Whitespace/newline/Unicode, HTML-looking literal, number formats, hidden metadata, merge and empty sheet.');
save('book-stream-name', streamEdit(valuesBytes, value => value, 'Book'), 'Same genuine BIFF8 workbook using root Book stream.');

const dates1904 = write({ Dates: {
  A1: { t: 'n', v: 0, z: 'yyyy-mm-dd' },
  A2: { t: 'n', v: 43830, z: 'yyyy-mm-dd' }, '!ref': 'A1:A2',
} }, undefined, { date1904: true });
const datesReadBack = X.read(dates1904, { type: 'buffer', cellNF: true });
const dateStream = X.CFB.find(X.CFB.read(dates1904, { type: 'buffer' }), 'Workbook').content;
let encoded1904 = false;
for (let offset = 0; offset + 4 <= dateStream.length;) {
  const id = dateStream.readUInt16LE(offset), size = dateStream.readUInt16LE(offset + 2);
  if (id === 0x0022 && size === 2 && dateStream.readUInt16LE(offset + 4) === 1) encoded1904 = true;
  offset += 4 + size;
}
if (!encoded1904 || datesReadBack.Workbook.WBProps.date1904 !== true ||
    datesReadBack.Sheets.Dates.A1.w !== '1904-01-01' || datesReadBack.Sheets.Dates.A2.w !== '2024-01-01') {
  throw Error('1904 date-system fixture was not encoded/read back correctly.');
}
save('date-system-1904', dates1904, 'Genuine BIFF8 DATEMODE=1; stored serial 0 and 43830 display 1904-01-01 and 2024-01-01. SheetJS readback only, not Excel certification.');

const offsetRange = write({ Offset: {
  Z8: { t: 'n', v: 7, z: '000000' }, AA8: { t: 's', v: 'Synthetic amount' },
  Z28: { t: 's', v: 'Last of 21 rows' }, AA28: { t: 'n', v: 12.5, z: '$0.00' },
  '!ref': 'Z8:AA28',
} });
const offsetReadBack = X.read(offsetRange, { type: 'buffer', cellNF: true }).Sheets.Offset;
if (offsetReadBack['!ref'] !== 'Z8:AA28' || offsetReadBack.Z8.w !== '000007' || offsetReadBack.AA28.w !== '$12.50') {
  throw Error('Offset-range fixture lost bounds or formats on readback.');
}
save('offset-range-z-aa', offsetRange, 'Nonzero Z8:AA28 used range: 21 rows crossing Z to AA, leading-zero and currency display strings.');

const distinctNames = write({
  Alpha1: X.utils.aoa_to_sheet([['FIRST original sheet']]),
  Alpha2: X.utils.aoa_to_sheet([['SECOND original sheet']]),
});
const distinctReadBack = X.read(distinctNames, { type: 'buffer' });
if (distinctReadBack.Sheets.Alpha1.A1.v !== 'FIRST original sheet' ||
    distinctReadBack.Sheets.Alpha2.A1.v !== 'SECOND original sheet') throw Error('Distinct-sheet control lost source values.');
save('distinct-sheet-names', distinctNames, 'Valid two-sheet control with independently distinguishable original values.');
for (const [id, duplicate] of [['duplicate-sheet-names', 'Alpha1'], ['case-duplicate-sheet-names', 'alpha1']]) {
  const mutated = streamEdit(distinctNames, stream => {
    let boundSheets = 0;
    for (let offset = 0; offset + 4 <= stream.length;) {
      const record = stream.readUInt16LE(offset), size = stream.readUInt16LE(offset + 2);
      if (record === 0x0085 && ++boundSheets === 2) {
        const count = stream[offset + 10], wide = stream[offset + 11] & 1;
        if (count !== duplicate.length) throw Error('Unexpected synthetic BoundSheet name length.');
        Buffer.from(duplicate, wide ? 'utf16le' : 'latin1').copy(stream, offset + 12);
        return stream;
      }
      offset += 4 + size;
    }
    throw Error('Second BoundSheet record not found.');
  });
  const readBack = X.read(mutated, { type: 'buffer' });
  if (readBack.SheetNames.join('|') !== `Alpha1|${duplicate}` ||
      readBack.Sheets[duplicate].A1.v !== 'SECOND original sheet') throw Error('Duplicate-name mutation did not read back as intended.');
  if (duplicate === 'Alpha1' && readBack.Sheets.Alpha1.A1.v !== 'SECOND original sheet') throw Error('Expected dictionary overwrite was not reproduced.');
  save(id, mutated, 'Deliberately invalid duplicate BoundSheet names (case-insensitive); reject instead of displaying overwritten or ambiguous sheet values.', 'malformed_workbook');
}

// BIFF8 parsed formula: length=7, integer 1, integer 2, addition. `bf` writes
// genuine FORMULA records; ordinary SheetJS `f` alone does not suffice here.
const bf = Buffer.from([7, 0, 0x1e, 1, 0, 0x1e, 2, 0, 3]);
const formulaBytes = write({ Formula: {
  A1: { t: 'n', v: 999, bf }, A2: { t: 'n', bf },
  A3: { t: 's', v: '=1+2' }, '!ref': 'A1:A3',
} });
const readBack = X.read(formulaBytes, { type: 'buffer', cellFormula: true }).Sheets.Formula;
if (readBack.A1.f !== '1+2' || readBack.A1.v !== 999 || readBack.A2.f !== '1+2' || readBack.A2.v !== '') throw Error('Synthetic formula fixture did not round-trip.');
save('formula-caches', formulaBytes, 'Real BIFF8 cached 999 for 1+2; valid cached blank string; literal equals text.');
for (const [id, type] of [['chart-substream', 0x20], ['macro-substream', 0x40]]) {
  save(id, streamEdit(formulaBytes, stream => {
    let offset = 0;
    while (offset + 8 <= stream.length) {
      const record = stream.readUInt16LE(offset), size = stream.readUInt16LE(offset + 2);
      if (record === 0x0809 && stream.readUInt16LE(offset + 6) === 0x10) {
        stream.writeUInt16LE(type, offset + 6);
        return stream;
      }
      offset += 4 + size;
    }
    throw Error('Worksheet BOF not found.');
  }), 'Synthetic unsupported BOF type marker; not a complete real chart or macro payload.', 'unsupported_format');
}
save('missing-string-cache', streamEdit(formulaBytes, stream => {
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const id = stream.readUInt16LE(offset), size = stream.readUInt16LE(offset + 2);
    if (id === 6) {
      const result = offset + 10;
      stream.fill(0, result, result + 8);
      stream.writeUInt16LE(0xffff, result + 6); // String marker, deliberately no mandatory following String record.
      return stream;
    }
    offset += 4 + size;
  }
  throw Error('No FORMULA record in fixture.');
}), 'Deliberately malformed FORMULA string cache with missing mandatory String record; not a valid cache-less workbook.', 'malformed_workbook');
save('encryption-marked', streamEdit(formulaBytes, stream => {
  const firstEnd = 4 + stream.readUInt16LE(2);
  const filePass = Buffer.from([0x2f, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([stream.subarray(0, firstEnd), filePass, stream.subarray(firstEnd)]);
}), 'Synthetic FILEPASS declaration to prove rejection before parsing; not cryptographically encrypted content.', 'encrypted_workbook');

save('row-limit', write({ Large: { A1: { t: 's', v: 'start' }, A201: { t: 's', v: 'end' }, '!ref': 'A1:A201' } }), '201-row range, only two populated cells.', 'preview_limit');
save('column-limit', write({ Wide: { A1: { t: 's', v: 'start' }, AY1: { t: 's', v: 'end' }, '!ref': 'A1:AY1' } }), '51-column range.', 'preview_limit');
save('sparse-area-limit', write({ Sparse: { A1: { t: 's', v: 'start' }, AX101: { t: 's', v: 'end' }, '!ref': 'A1:AX101' } }), '5050 rendered positions with only two populated cells.', 'preview_limit');
save('sheet-limit', write(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Sheet${i + 1}`, X.utils.aoa_to_sheet([['Synthetic']])]))), 'Nine ordinary worksheets.', 'preview_limit');
save('text-limit', write({ Text: X.utils.aoa_to_sheet([['文'.repeat(200)]]) }), '600 UTF-8 bytes exceed the prototype 512-byte cell-text limit.', 'preview_limit');
const big = {};
for (let r = 0; r < 40; r++) for (let c = 0; c < 50; c++) big[X.utils.encode_cell({ r, c })] = { t: 's', v: '文'.repeat(170) };
big['!ref'] = 'A1:AX40';
save('output-limit', write({ Output: big }), '2000 cells of 510 UTF-8 bytes each fit individual/range bounds but full serialized output exceeds 1 MiB.', 'preview_limit');
save('corrupt', Buffer.from('Synthetic bytes, not an Excel file.'), 'Non-CFB bytes renamed .xls.', 'unsupported_format');
save('malformed-record', streamEdit(formulaBytes, stream => { stream.writeUInt16LE(0xffff, 2); return stream; }), 'CFB container with BIFF record extending beyond stream.', 'malformed_workbook');
const manifest = { provenance: 'Original AI-generated synthetic fixtures; no real documents; not SME-reviewed.',
  generator: 'generate.cjs', sheetjs: X.version,
  formulaCacheNote: 'BIFF8 FormulaValue has a cached value including valid blank strings. The missing-string-cache fixture is deliberately malformed and must reject, not masquerade as valid missing-cache evidence.', fixtures };
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Generated ${fixtures.length} synthetic fixtures.`);
